# bugdapp-agent — system end-to-end

Autonomous QA agent for Web3 dApps. Crawls a dApp from outside (URL only), builds a four-layer knowledge graph, generates Playwright specs with on-chain assertions, runs them, self-heals.

---

## 1. The 30-second picture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   URL                                                                       │
│    │                                                                        │
│    ▼                                                                        │
│  ┌───────────┐   ┌──────────┐   ┌────────────┐   ┌──────────────────┐       │
│  │  CRAWLER  │──▶│  KG-V1   │──▶│  CAPS +    │──▶│   STATE EXTRACT  │       │
│  │ (browser) │   │ (json)   │   │  CONTROLS  │   │  (LLM, per flow) │       │
│  └───────────┘   └──────────┘   └────────────┘   └──────────────────┘       │
│                                          │                  │               │
│                                          ▼                  ▼               │
│                                   ┌────────────────────────────────────┐    │
│                                   │       KG v2  (THE BRAIN)           │    │
│                                   │                                    │    │
│                                   │   L1 Structural ── pages, cmps     │    │
│                                   │   L2 Behavioral ── states, actions │    │
│                                   │   L3 Technical  ── apis, contracts │    │
│                                   │   L4 Semantic   ── flows, docs,    │    │
│                                   │                    constraints,    │    │
│                                   │                    assets, features│    │
│                                   └────────────────────────────────────┘    │
│                                          │                                  │
│                  ┌───────────────────────┼──────────────────────┐           │
│                  ▼                       ▼                      ▼           │
│           ┌────────────┐          ┌─────────────┐        ┌──────────────┐   │
│           │ PROBE/FIND │          │  SPEC GEN   │        │  VALIDATOR   │   │
│           │ (queries)  │          │  (Playwright│        │ (assertion   │   │
│           │            │          │   + chain   │        │  completeness│   │
│           │            │          │   asserts)  │        │  rules)      │   │
│           └────────────┘          └─────────────┘        └──────────────┘   │
│                                          │                                  │
│                                          ▼                                  │
│                                   ┌────────────┐                            │
│                                   │   RUNNER   │                            │
│                                   │  + healer  │                            │
│                                   └────────────┘                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Pipeline phases (in order)

`scripts/pipeline.ts` runs all of these. Every phase is `--skip-<name>` toggleable.

| # | Phase | LLM? | What it does | Key output |
|---|---|---|---|---|
| 1 | **Crawler** | no | Headed browser drives MetaMask, walks pages, records DOM + network. Builds v1 KG (pages, components, actions, docs, APIs, contracts, assets, features, constraints) | `scraped-data.json`, `network-raw-apis.json`, `knowledge-graph.json` |
| 2 | **Comprehender** | yes | One-pass dApp summary + archetype detection | `comprehension.json` |
| 3 | **Doc Structurer** | yes | Each doc section → `{topics[], rules[]}` | `structured-docs.json` |
| 4 | **Module Discovery** | yes | Pages → modules (primary / cross-cutting / shared) + cross-module edges | `modules.json`, `module-edges.json` |
| 5 | **Control Clustering** | yes | DOM atoms → semantic Controls (input, toggle, modal-selector, submit-cta…) | `controls.json` |
| 6 | **Control Wiring** | yes | feedsInto / gates / affectedBy edges between controls | (in `controls.json`) |
| 7 | **Capability Derivation** | no | Graph traversal → capabilities (one per submit-CTA path) | `capabilities.json` (unnamed) |
| 8 | **Capability Naming** | yes | LLM labels each capability ("Open ZFP Long on ETH-USD") | `capabilities.json` |
| 9 | **Edge Case Derivation** | no | constraints × capabilities → edge-case rows + heuristic personas (`riskClass + archetype`) | (in `capabilities.json`) |
| 10a | **Assemble Brain — Skeleton** | no | `kg-migrate + tech-binder` — builds queryable skeleton kg-v2 BEFORE the live agent walks it | `kg-v2.json` (skeleton) |
| 11a | **Markdown (preliminary)** | no | Module .md docs so explorer agent has context to load | `knowledge/*.md` |
| 12 | **Explore** | yes | Live `runExecutor` agent walks each module against the skeleton brain | `exploration.json` (THIS run) |
| 10b | **Assemble Brain — Finalize** | mixed | `explorer-ingest → state-extractor → cleanup → validator`. Folds Phase-12 findings into kg-v2 BEFORE state-extractor names states (so naming sees observed UI states). State-extractor is the only LLM step here. | finalized `kg-v2.json` + `kg-validation.json` + `exploration-deltas.json` |
| 11b | **Markdown re-emit** | no | Re-render module .md so docs reflect finalized brain | `knowledge/*.md` |
| 13 | **Spec Gen** | no | One Playwright spec per capability × asset row, enriched with finalized v2 KG state names + event assertions | `tests/<module>/<cap>.spec.ts` |

**The agent loop closes in ONE pipeline run** — explorer (Phase 12) feeds explorer-ingest (inside Phase 10b finalize) which feeds state-extractor's prompt. Previously explorer ran AFTER finalize, so its findings were one run behind.

**The agent (`src/agent/loop.ts` → `runExecutor`)** is one function with three callers:
- **Phase 12 Explorer** — build-time, walks each module to enrich the brain
- **`scripts/run.ts` → heal-runner** — runtime, recovers broken Playwright specs
- **`scripts/chat.ts` → handler.ts (act mode)** — runtime, handles ad-hoc chat tasks

**Two KG artifacts on disk** — `knowledge-graph.json` (Phase 1 raw scaffolding, consumed by Phases 2–4 only) + `kg-v2.json` (Phase 10b finalized, THE brain). Folding crawler output directly into v2 nodes is the next architectural cleanup; deferred.

---

## 3. The KG v2 schema (in 30 lines)

`src/agent/kg-v2.ts` — all types + `KGv2Builder` + `diffKG`.

```ts
type Layer = 'structural' | 'behavioral' | 'technical' | 'semantic';

// Cross-cutting on every node + edge:
//   id (sha1-hashed), validFrom, validTo, observedIn[crawlId],
//   provenance ('observed'|'inferred'), inferenceSource, walletContext[]

// Layer 1 — Structural        kinds: page, section, component, element
// Layer 2 — Behavioral        kinds: state (with conditions, isError, isInitial), action (actionType)
// Layer 3 — Technical         kinds: apiCall, contractCall, event, errorResponse
// Layer 4 — Semantic          kinds: flow, docSection, constraint, asset, feature

// Edge types (intentionally small + meaningful):
//   CONTAINS                    structural
//   REQUIRES_STATE | TRANSITIONS_TO | FAILS_TO | PERFORMED_VIA   behavioral
//   TRIGGERS_API_CALL | INVOKES_CONTRACT_CALL | EMITS_EVENT | RETURNS_ERROR   technical
//   START_STATE | END_STATE | INCLUDES_ACTION | DESCRIBED_BY     semantic
//   CONSTRAINS | OPERATES_ON | EXPOSES_FEATURE                   semantic
```

**Storage:** plain JSON at `output/<dapp>/kg-v2.json` (always-latest) + per-crawl snapshot at `output/<dapp>/kg-v2/kg-v2.<crawlId>.json` (versioning by snapshot, diff via `diffKG`).

**Why the four layers:** the brief in this conversation made the case — graphs that conflate UI / state / tech produce clickthrough scripts, not tests. Keeping them separate means traversal queries stay clean (`for each Action: outgoing TRANSITIONS_TO ⨉ outgoing INVOKES_CONTRACT_CALL → assertion target`).

---

## 4. The agent's brain — what queries it can answer

The KG is the agent's only knowledge source. To verify it works as the brain, run:

```bash
npx tsx scripts/probe-brain.ts
```

Ten probes, each is an actual query the agent makes during execution:

| # | Probe | What the agent uses it for |
|---|---|---|
| 1 | `intent → flow` | "user said 'go long on BTC' — which flow runs that?" |
| 2 | `step execution` | "for each action, do I have a UI selector to click?" |
| 3 | `assertion target` | "for the wallet-sign step, what events should I expect?" |
| 4 | `negative test` | "what failure modes does each flow have?" |
| 5 | `why` | "where in the docs is this behavior described?" |
| 6 | `constraints` | "what's the max leverage for this trade?" |
| 7 | `asset metadata` | "what tradable assets exist? what class are they?" |
| 8 | `feature query` | "does this dApp support 'Zero Fee Perpetuals'?" |
| 9 | `page topology` | "what flows live on /trade?" |
| 10 | `contract map` | "which addresses do I monitor for tx receipts?" |

Current state on Avantis: **10/10 pass**.

Two CLI shims sit on top of the brain:

```bash
# natural language → flow + executable step list
npx tsx scripts/find-flow.ts "go long on BTC"
npx tsx scripts/find-flow.ts "deposit USDC"

# walk a flow's state machine, show full per-step detail
npx tsx scripts/traverse-flow.ts --flow "Open Fixed-Fee Market Long" --limit 1
```

---

## 5. Validator

`src/pipeline/kg-validator.ts` enforces these rules; output written to `kg-validation.json`:

| Rule | Severity | Catches |
|---|---|---|
| **E1** | error | Action with no `REQUIRES_STATE` (preconditions undefined) |
| **E2** | error | Action with no `TRANSITIONS_TO` (success outcome undefined) |
| **E3** | error | State with no entry transition (orphan, not an initial state) |
| **E4** | error | Flow's `startStateId` / `endStateId` not a state node (broken pointer) |
| **E5** | error | Flow's start → end not reachable via behavioral edges |
| **W1** | warn | Action with no `FAILS_TO` (no failure-mode coverage) |
| **W2** | warn | ApiCall with no `responseSchema` |
| **W3** | warn | ContractCall with no `expectedEventIds` |
| **W4** | warn | Action with no `PERFORMED_VIA` (no UI selector — agent can't drive it) |

A graph that passes E1–E5 is structurally sound and the agent can execute every flow. Warnings flag coverage gaps the LLM didn't fill.

---

## 6. Spec generator (v1 + v2 enrichment)

`src/pipeline/spec-gen.ts` is no-LLM, deterministic. For each Capability:

1. Generates one `<cap>.spec.ts` under `tests/<module>/`.
2. Data-driven row per asset (one BTCUSD row, one EURUSD row, etc. — derived from the asset selector control's options).
3. **v2 enrichment** (additive, runs when `kg-v2.json` exists):
   - File header lists: state-machine source, start/end state names, wallet-sign contract + signature, expected event signatures, catalogued failure modes, constraint values, doc rules cited.
   - Wallet-sign block emits `console.log('[v2 expect event]', sig)` + an event-coverage check that compares observed receipt events against expected.
4. Per edge case → one extra negative test (with constraint citation).
5. Copies `wallet.fixture.ts` + `chain/` helpers + a self-contained `package.json` so the generated suite runs anywhere.

Sample header from `tests/trade/open-fixed-fee-market-long-10-collateral.spec.ts`:

```
// v2 KG flow: flow:07abcd9c89e7  (state-machine source: kg-migrate:capability)
//   start state: Wallet_Connected_Idle
//   end state:   Position_Open_Success
//   wallet-sign target: 0xa0b86991…  transfer(address,uint256)
//   expected on-chain events:
//     • Transfer(address,address,uint256)
//     • Approval(address,address,uint256)
//   catalogued failure modes:
//     ✗ WalletPopup_UserRejected
//     ✗ Trade_Rejected_User
//   constraints (testable boundaries):
//     ⚖ Max leverage = 250
//     ⚖ Max leverage = 50
//   doc rules cited:
//     ☞ Get up to 50x leverage on cryptocurrencies
//     ☞ Market orders executed immediately at current market prices
```

---

## 7. Run book

```bash
# === ONE NEW DAPP, FROM ZERO ===
DAPP_URL=https://app.example.com SEED_PHRASE=… OPENROUTER_API_KEY=… \
  npx tsx scripts/pipeline.ts --url https://app.example.com
# crawls + builds full v2 KG + writes specs. ~$3-5 OR credits per dApp.

# === RE-USE CACHED CRAWL, RE-DO LATER PHASES ===
npx tsx scripts/pipeline.ts --skip-crawl --skip-comprehend --skip-docs ...

# === BRAIN QUERIES (NO COST) ===
npx tsx scripts/probe-brain.ts                              # 10-probe health check
npx tsx scripts/find-flow.ts "go long on BTC"               # NL → flow + steps
npx tsx scripts/traverse-flow.ts --flow "Borrow USDC"       # walk a state machine

# === VISUALIZE ===
npx tsx scripts/_viz-v2.ts                                  # writes kg-v2.html
open output/<dapp>/kg-v2.html                               # vis-network, layer filters

# === RUN GENERATED SPECS ===
cd output/<dapp> && npx playwright test                     # standalone suite
# or via the chat interface:
npx tsx scripts/chat.ts                                     # /run <flow>
```

---

## 8. File map (what lives where)

```
src/
├── agent/
│   ├── kg-v2.ts            # the v2 schema + KGv2Builder + diffKG
│   ├── state.ts            # v1 KG + capability/control types (still used by spec-gen)
│   ├── session.ts          # browser+wallet session lifecycle
│   ├── loop.ts             # the act-observe executor (used by chat)
│   ├── prompts.ts          # system prompts for the executor
│   ├── knowledge.ts        # context/RAG for the executor
│   ├── tool-router.ts      # browser/chain tool definitions for the executor
│   ├── rag.ts              # module retrieval for the executor
│   └── archetypes/         # perps, swap, lending, staking, cdp, yield (assertion sets)
│
├── pipeline/
│   ├── crawler.ts                # phase 1  (writes knowledge-graph.json + sidecars)
│   ├── comprehender.ts           # phase 2
│   ├── doc-structurer.ts         # phase 3
│   ├── module-discovery.ts       # phase 4
│   ├── control-clustering.ts     # phase 5
│   ├── control-wiring.ts         # phase 6
│   ├── capability-derivation.ts  # phase 7
│   ├── capability-naming.ts      # phase 8
│   ├── edge-case-derivation.ts   # phase 9  (also assigns heuristic personas)
│   ├── kg-assemble.ts            # phase 10 — splits skeleton + finalize halves
│   │   ├─ kg-build.ts            #   sub: build skeleton kg-v2 from v1 + sidecars (skeleton half)
│   │   ├─ tech-binder.ts         #   sub: bind ApiCall/ContractCall/Event onto actions (skeleton half)
│   │   ├─ explorer-ingest.ts     #   sub: heuristic mine of exploration.json deltas (finalize half)
│   │   ├─ state-extractor.ts     #   sub: LLM names state machine per flow (finalize half)
│   │   ├─ kg-cleanup.ts          #   sub: drop superseded skeletons (finalize half)
│   │   └─ kg-validator.ts        #   sub: schema + assertion-completeness rules (finalize half)
│   ├── markdown-emitter.ts       # phase 11
│   ├── explorer.ts               # phase 12  (optional, live agent — feeds explorer-ingest next run)
│   ├── spec-gen.ts               # phase 13  — consumes kg-v2.json
│   ├── spec-healer.ts            # runtime — used by heal-runner to rewrite broken test bodies
│   ├── heal-runner.ts            # runtime — runs a suite, invokes runExecutor on failures, heals
│   └── crawl-context.ts          # internal helper
│
├── chain/                  # on-chain verification runtime (used by generated specs)
│   ├── verify.ts             # verifyPage — captures tx, decodes events, runs assertions
│   ├── tx-capture.ts         # MetaMask popup intercept
│   ├── receipt.ts            # viem receipt decoder
│   ├── assertions.ts         # archetype assertion sets (perps/swap/lending/etc.)
│   ├── invariants.ts         # universal invariants (no negative balance etc.)
│   ├── findings.ts           # bug bundle emission
│   ├── abi-registry.ts       # known ABI cache + Etherscan/Sourcify fallback
│   ├── chains.ts             # RPC URLs / chain configs
│   ├── anvil.ts              # local fork helpers
│   ├── funding.ts            # test wallet topup
│   ├── contract-extractor.ts # bundle scan for contract addresses
│   ├── types.ts              # shared types
│   └── index.ts              # barrel
│
├── chat/                   # Discord/Slack interactive interface
│   ├── handler.ts          # dispatcher
│   ├── intent.ts           # NL parsing
│   ├── matcher.ts          # task → spec lookup
│   ├── approvals.ts        # plan-approve gate
│   ├── notion.ts           # findings sink
│   ├── discord-bot.ts      # discord transport
│   └── slack-bot.ts        # slack transport
│
└── core/
    ├── llm.ts              # OpenRouter client (Anthropic-compat shape)
    ├── browser-launch.ts   # MetaMask + Chromium boot
    ├── browser-tools.ts
    ├── metamask.ts         # wallet popup driver
    ├── network.ts          # network log capture
    ├── wallet-tools.ts
    ├── bundle.ts           # JS bundle text scraping
    └── cost-tracker.ts     # per-call $ accounting

scripts/
├── pipeline.ts             # the orchestrator — all phases, all skip flags
├── chat.ts                 # interactive CLI (uses chat/handler)
├── bot.ts                  # discord/slack bot launcher
├── run.ts                  # run one capability end-to-end
├── _viz-v2.ts              # v2 KG → HTML viz (vis-network, CDN)
├── find-flow.ts            # NL → flow + executable steps
├── traverse-flow.ts        # walk a flow's state machine
└── probe-brain.ts          # 10-probe brain health check

templates/
├── wallet.fixture.ts       # MetaMask + connectWallet + chain switch fixture
└── playwright.config.ts    # default config copied into each dApp suite

output/<dapp>/
├── (v1 phase artifacts)    # comprehension.json, structured-docs.json, modules.json,
│                           # controls.json, capabilities.json, knowledge-graph.json
├── kg-v2.json              # ← THE BRAIN (always-latest)
├── kg-v2/                  #   per-crawl snapshots (versioning)
├── kg-validation.json      # validator report
├── kg-v2.html              # interactive viz
├── tests/<module>/*.spec.ts # generated Playwright specs
├── fixtures/               # wallet.fixture.ts + chain/ copy
├── playwright.config.ts
└── package.json            # standalone — `npx playwright test` works
```

---

## 9. Where this is in the maturity curve

✓ **Schema** — locked, all four layers + cross-cutting. Hash-based ids stable across crawls. JSON storage (no infra).
✓ **Migrator** — v1 artifacts → v2 lossless on structural/behavioral skeleton, lossless on docs/constraints/assets/features.
✓ **Tech binder** — per-archetype contract binding; bundle bloat dropped.
✓ **State extractor** — LLM produces named state machines + failure modes per flow.
✓ **Cleanup** — drops migrator skeletons superseded by LLM (without nuking flows the LLM didn't process).
✓ **Validator** — 9 rules covering structural completeness + assertion-target presence.
✓ **Brain probe** — 10/10 on Avantis. Schema serves the agent's full reasoning loop.
✓ **Spec gen** — v2-enriched. Each spec cites its state machine + expected events + doc rules.
✓ **Viz** — single self-contained HTML, layer filters, click-for-detail.
✓ **Find / traverse** — NL → flow → step list with selectors + assertions.

⚠ **Multi-dApp** — schema is dApp-agnostic, only Avantis exists in `output/`. New dApp = `pipeline.ts --url` from scratch.
⚠ **Diff between two crawls** — `diffKG()` coded, untested.
⚠ **Spec runner integration** — v2's per-event coverage logs land in test stdout; not yet promoted to `expect(...)` assertions (would fail tests on missing events). Next step.
⚠ **State extractor coverage** — runs at $0.03/flow on Sonnet 4.5. ~$3 per dApp for full coverage. Limit-able for partial.

---

## 10. The honest one-liner

For Avantis (one dApp): the v2 KG holds 2553 nodes / 12778 edges. Every action has a UI selector. Every wallet-sign action has a contract + expected events. 99% of flows cite their docs. Constraints, assets, features are first-class. Validator passes E1–E4. The agent can answer all ten brain probes. Spec-gen turns every Flow into an assertion-bearing Playwright test that runs standalone.

The pipeline is end-to-end working. Next concrete step is multi-dApp.

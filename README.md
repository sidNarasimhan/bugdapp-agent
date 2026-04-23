# bugdapp-agent

Autonomous QA agent for Web3 dApps. Given a dApp URL, it crawls the site + docs + APIs, reasons about what the dApp is using an LLM, generates a Playwright regression test suite, runs it with a MetaMask wallet fixture, and emits a per-dApp outreach report.

---

## Quickstart

```bash
# Full loop on a dApp (crawl + comprehension + spec-gen + outreach)
npm run live https://aerodrome.finance

# Re-run reusing cached artifacts (fast, zero LLM cost)
npm run live https://aerodrome.finance -- --skip-crawl --skip-comprehend

# Inspect what got produced
ls output/<hostname>/
cat output/<hostname>/OUTREACH.md
```

Environment (`.env`) must have:
- `SEED_PHRASE` — 12-word MetaMask test wallet seed
- `OPENROUTER_API_KEY` — LLM credits (~$0.001–0.003 per dApp for comprehension)
- `METAMASK_PATH` — absolute path to the bundled `metamask-extension/` dir
- `FOUNDRY_BIN` *(optional)* — path to Anvil for forked-chain execution

---

## Project layout

```
bugdapp-agent/
├── scripts/              ← 9 entry-point scripts (see "npm scripts" below)
├── src/
│   ├── agent/
│   │   ├── nodes/        ← LangGraph pipeline nodes (the core)
│   │   ├── archetypes/   ← per-dApp-class logic (swap/perps/lending/...)
│   │   ├── profiles/     ← per-dApp thin overrides (22 profiles)
│   │   ├── chain/        ← on-chain verification (receipts, invariants, findings)
│   │   └── state.ts      ← KG types + DAppGraph class + state reducers
│   ├── phases/           ← browser-driven phase impls (crawl + explore)
│   ├── prompts/          ← explorer LLM prompts
│   ├── browser/          ← Chromium launcher + MM setup + browser tools
│   ├── graph/            ← state graph (used by explorer)
│   └── llm/              ← OpenRouter client + cost tracker
├── templates/            ← wallet.fixture.ts + playwright.config.ts (copied per dApp)
├── metamask-extension/   ← bundled MM v13.22 MV3 extension
├── test/                 ← vitest unit tests
├── output/               ← per-dApp artifacts (one subdir per hostname)
├── data/abis/            ← on-disk ABI cache (populated by chain module)
├── docs/                 ← long-form documentation
│   ├── ARCHITECTURE.md   ← original architecture notes
│   ├── DESIGN.md         ← original design doc
│   ├── HANDOFF.md        ← detailed operational guide + known bugs
│   └── history/          ← session change logs
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## The pipeline (10 phases)

Driven by `scripts/run-pipeline.ts`. Every phase reads/writes `output/<hostname>/` so phases can be skipped + resumed from disk.

| # | Phase | LLM? | File | Output |
|---|---|---|---|---|
| 1 | **Crawler** | no | `src/agent/nodes/crawler.ts` + `src/phases/context.ts` | `context.json`, `scraped-data.json`, `network-raw-apis.json`, `interactions.json`, `bundle-analysis.json`, initial `knowledge-graph.json` |
| 2 | **KG Builder** | no | `src/agent/nodes/kg-builder.ts` | `graph.json` (typed edges: CONTAINS, REVEALS, CONFIGURES, SUBMITS, CONSTRAINS, HAS_OPTION) |
| 2b | **Flow Computer** | no | `src/agent/nodes/flow-computer.ts` | `kg.flows[]` populated with cross-product `flow:computed:*` entries |
| 2c | **Flow Validator** | no (browser) | `src/agent/nodes/flow-validator.ts` | `valid-flows.json` — each pattern marked valid/invalid/ambiguous |
| 3 | **Context Builder** | no | `src/agent/nodes/context-builder.ts` | compact summary for the explorer LLM |
| 4 | **Explorer** | yes (agentic) | `src/agent/nodes/explorer.ts` + `src/phases/explorer.ts` | `exploration.json`, `explorer-kg-update.json` |
| 5 | **Planner** | yes | `src/agent/nodes/planner.ts` | `test-plan.json` |
| 5.5 | **Comprehension** | yes | `src/agent/nodes/comprehension.ts` | `comprehension.json` — archetype + ranked flows + constraints + risks + adversarial targets |
| 6 | **Matrix Filler** | no | `src/agent/nodes/matrix-filler.ts` | parameters expanded in `test-plan.json` |
| 7a | **Spec Generator** | no | `src/agent/nodes/spec-generator.ts` *(legacy)* or `src/agent/nodes/comprehension-spec-gen.ts` *(new, comprehension-driven)* | `tests/*.spec.ts`, `fixtures/wallet.fixture.ts`, `fixtures/chain/*` |
| 7b | **Test Runner** | no (browser) | `src/agent/nodes/test-runner.ts` | `test-results.json`, `findings/<id>/` on any failure |
| 8 | **Healer** | yes | `src/agent/nodes/healer.ts` + `src/phases/healer.ts`* | patched spec, rerun |

*`phases/healer.ts` was removed in cleanup — healer LLM prompting lives in the node file now. The legacy stack was deleted.*

### Two orchestrators

- **`npm run pipeline`** (`scripts/run-pipeline.ts`) — runs ALL 10 phases: crawl → KG → flow-compute → flow-validate → context-build → **explorer** → **planner** → matrix-fill → **legacy spec-gen** → **test-run + heal**. This is the cold end-to-end path. Uses `src/agent/nodes/spec-generator.ts` for generation.

- **`npm run live`** (`scripts/live.ts`) — short loop: crawl → **comprehension** → **comprehension-spec-gen** → outreach. Skips explorer, planner, matrix-filler, test-runner, healer. Used for fast iteration + tuning. Add `--run-suite` to also execute the generated specs via Playwright. Uses `src/agent/nodes/comprehension-spec-gen.ts` for generation (archetype-dispatched, reads `comprehension.json` directly).

Both paths generate Playwright specs under `output/<host>/tests/` using the same wallet fixture + chain-verify stack.

---

## Knowledge Graph shape

Defined in `src/agent/state.ts`. The `KnowledgeGraph` has:
- `pages[]` — URL + name + element count + walletRequired
- `components[]` — id, pageId, role, name, selector, disabled, dynamic
- `actions[]` — interaction records (click/type/toggle → DOM delta)
- `flows[]` — multi-step user journeys (category, priority, steps, requiresFundedWallet)
- `edgeCases[]` — boundary tests for each flow
- `features[]` — dApp capabilities (from docs)
- `assets[]` — per-dApp entities (tokens, trading pairs, markets)
- `constraints[]` — limits from docs (`Max leverage = 250x`, etc.) with `testImplication`
- `docSections[]` — structured docs content + keywords
- `apiEndpoints[]` — captured API paths + description
- `dropdownOptions[]`
- `contracts[]` — `0x{40}` addresses with role + source + optional Etherscan verify
- `edges[]` — typed graph edges between nodes

`DAppGraph` (same file) is the traversable in-memory graph built by the KG Builder.

---

## Comprehension schema

`src/agent/nodes/comprehension.ts` exports the `Comprehension` type:

```typescript
{
  dappName, dappUrl,
  archetype: 'swap' | 'perps' | 'lending' | 'staking' | 'yield' | 'cdp' | 'bridge' | 'nft' | ...,
  archetypeConfidence: 0.0-1.0,
  archetypeEvidence: string[],     // citations from UI/docs/contracts
  summary: string,                  // 1 paragraph
  chains: string[],
  primaryFlows: [{                  // the ranked user journeys
    id, name, category, priority, rationale,
    entities: string[],             // tokens/markets/assets this flow acts on
    inputs: [{name, type, unit}],
    expectedOutcome,
    riskClass: 'safe' | 'medium' | 'high',
    contractEvents: string[],       // events asserted on-chain
    requiresFundedWallet: boolean,
  }],
  constraints: [{name, value, scope, source, testImplication}],
  risks: [{name, description, category, severity}],
  edgeCases: [{name, rationale, applicableToFlows}],
  adversarialTargets: string[],     // e.g. ['slippage-boundary','sandwich-attack']
  keyContracts: [{address, role, name?}],
  outreachPitch: string,            // 1-sentence pitch for the outreach report
}
```

Cached at `output/<host>/comprehension.json` after first run.

---

## Archetype system

`src/agent/archetypes/` defines per-dApp-class logic. Each file exports:

```typescript
{
  name,                          // 'swap' | 'perps' | 'lending' | ...
  defaultCtaTiers: RegExp[],     // priority order — primary action first, blockers last
  primaryActionPattern: RegExp,  // matches "Swap"/"Supply"/"Place Order"
  pickValues(values),            // converts profile config → runtime values
  classify(ctx),                 // classifies terminal form state from CTA text
  isPrimaryActionCta(text),
}
```

Archetypes: `perps`, `swap`, `lending`, `staking`, `yield`, `cdp`. Extended by `comprehension-spec-gen.ts` which adds per-archetype step emitters (e.g., perps uses asset-modal-then-direction-then-collateral, swap uses token-pair-then-amount, lending uses market-row-then-action-then-amount).

---

## Profile system

`src/agent/profiles/` — 22 per-dApp thin overrides. Each exports:

```typescript
{
  url, name,
  archetype: 'swap' | 'perps' | 'lending' | ...,
  network: {
    chain, chainId, chainHexId, rpcUrl, blockExplorerUrl, nativeCurrency,
  },
  values: {
    minPositionSizeUsd,
    preferredAmountUsd,
    targetLeverage,
  },
  selectors: {
    ctaTiers?,                   // override archetype defaults
    connect?: {                  // MM modal quirks
      preMetaMaskClicks?: (string | RegExp)[],   // Uniswap's "Other wallets" expander
      loginButtonPattern?: RegExp,
      loginButtonTestId?: string,
    },
  },
  inverseFlows?: [{              // cleanup: close position after perps trade, reverse swap, etc.
    name, route, ctaPattern, confirmPattern?,
  }],
}
```

`registry.ts` exports `PROFILES[]` + `getProfileOrThrow(url)` — URL-to-profile matching.

---

## On-chain verification layer

`src/agent/chain/` (13 files) — generic across EVM chains:

- `chains.ts` — chain catalogue + viem client factory
- `abi-registry.ts` — in-memory common ABIs → disk cache (`data/abis/`) → Etherscan V2 → Sourcify fallback
- `receipt.ts` — `fetchAndDecodeReceipt(chainId, hash)` via viem
- `tx-capture.ts` — Playwright init script that hooks `window.ethereum.request`, emits `[BUGDAPP_TX_CAPTURE]` markers on every `eth_sendTransaction`
- `assertions.ts` — universal (tx-captured, no-revert, wallet-involved) + per-archetype assertions
- `invariants.ts` — `no-unlimited-approval`, `no-unknown-recipients`, archetype-specific invariants
- `verify.ts` — `verifyPage(page, opts)` — the spec entry-point. Decodes receipts, runs assertions, returns findings
- `findings.ts` — writes Jam-style bundles: `finding.json`, `finding.md`, `assertions.json`, `receipts/*.json`, `index.html` viewer
- `anvil.ts` — fork spawn/kill via execa
- `funding.ts` — whale impersonation for Anvil fork funding
- `contract-extractor.ts` — regex over docs + network + bundles → role-tagged `KGContract[]`

---

## Wallet fixture (`templates/wallet.fixture.ts`)

Copied into every `output/<host>/fixtures/` at spec-gen time. Key exports:

- `test` — extended Playwright test fixture. Worker-scoped `walletContext` launches Chromium with MM extension loaded.
- `connectWallet(page, dappUrl, chainParams, connectHints)` — navigates, finds Login/Connect, handles Privy wrapper, per-profile pre-MM clicks, clicks MM option, runs `wallet_switchEthereumChain`. **Throws on handshake failure** (no silent passes).
- `ensureMetaMaskReady(context, seedPhrase)` — drives MM onboarding: Get Started → Existing Wallet → Import SRP → `fillSeedPhrase` → Create Password → dismiss post-setup modals.
- `fillSeedPhrase(mm, words)` — three-strategy SRP import:
  1. Per-word input grid (older MM shapes)
  2. MM 13.22's single `srp-input-import__srp-note` input — types word-by-word with Space separators (fix for the "seed cutoff" bug)
  3. Paste-button fallback via clipboard
- `raceConfirmTransaction(context, page)` — waits for MM confirmation popup in parallel with page updates
- `verifyPage`, `emitFindingIfNeeded`, `getTestWalletAddress` — re-exports from `./chain/`
- Loads `.env` from project root itself (Playwright subprocesses don't inherit shell env on Windows)

---

## Per-dApp output structure

```
output/<hostname>/
├── context.json              ← dApp metadata + chain + features + docs text
├── scraped-data.json         ← per-page element/dropdown/storage dump
├── crawl-pages.json          ← pages discovered
├── network-raw-apis.json     ← intercepted API responses
├── interactions.json         ← every click's DOM delta
├── discovered-flows.json     ← multi-step sequences found by crawler
├── bundle-analysis.json      ← JS bundle introspection
├── knowledge-graph.json      ← built KG
├── graph.json                ← serialized DAppGraph
├── comprehension.json        ← LLM reasoning output
├── test-plan.json            ← planner output
├── valid-flows.json          ← flow-validator output
├── adversarial-scenarios.json← adversarial generator output (if run)
├── OUTREACH.md               ← pitch report for the dApp team
├── tests/*.spec.ts           ← generated Playwright specs
├── fixtures/
│   ├── wallet.fixture.ts     ← copied from templates/
│   └── chain/*.ts            ← copied from src/agent/chain/
├── findings/<id>/            ← Jam-style bundles from real test runs
├── screenshots/              ← crawl screenshots
├── package.json              ← minimal deps for Playwright
└── playwright.config.ts
```

---

## npm scripts

```bash
npm run live <url>            # Full short loop: crawl → comprehension → specs → outreach
npm run pipeline -- --url <url>   # Full LangGraph pipeline (all 10 phases)
npm run comprehension <host>  # Just the LLM reasoning step
npm run spec-gen <url>        # Just spec emission from existing KG
npm run outreach <host>       # Just write OUTREACH.md
npm run adversarial <host>    # Generate adversarial scenarios
npm run batch-crawl           # Multi-dApp crawl (default set)
npm run anvil <host>          # Run generated suite against Anvil fork
npm run watch <host>          # Drift detection baseline + interval
npm run typecheck             # tsc --noEmit
npm run test                  # vitest run
```

---

## Current state (2026-04-18)

**5 dApps have full crawl + comprehension + specs + outreach:**
- Avantis (perps, Base) — 21 specs, 122 tests
- Aave (lending, Base) — 5 specs, 21 tests
- Aerodrome (swap, Base) — 4 specs, 25 tests
- Morpho (lending, Base) — 4 specs, 25 tests
- Compound (lending, Base) — 4 specs, 13 tests

Test wallet on Base: `0xEBd478457e5555FB49683874925ed1cBBB987Ee6` (~$0.70 ETH + ~$1.98 USDC).
OpenRouter credits: ~$10.01 remaining.

**MetaMask seed import**: fixed today. Verified end-to-end — wallet onboards successfully through MM 13.22 via `fillSeedPhrase` typing word-by-word.

**Still untested in this session**: actual spec execution against a live dApp post-fix. The `connectWallet` → form-fill → submit → finding-bundle path compiles but hasn't been exercised.

For deep operational notes + known-bug reference, see `docs/HANDOFF.md`.

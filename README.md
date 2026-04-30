# bugdapp-agent

Autonomous QA agent for Web3 dApps. Crawls a dApp from a URL, builds a four-layer knowledge graph (KG v2), generates Playwright specs with on-chain assertions, runs them with a MetaMask fixture, and self-heals failures via a browser-driving agent. Talks to you over CLI / Discord / Slack.

Full architecture in [`SYSTEM.md`](./SYSTEM.md).

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
# edit .env: OPENROUTER_API_KEY, SEED_PHRASE, METAMASK_PATH
```

Required env:
- `OPENROUTER_API_KEY` — Sonnet 4.5 + DeepSeek routing
- `SEED_PHRASE` — 12-word BIP39 seed of a TEST wallet (use a burner)
- `METAMASK_PATH` — absolute path to the bundled MetaMask extension dir

Optional:
- `DAPP_URL` — override active dApp (default Avantis)
- `EXECUTOR_MODEL`, `PLANNER_MODEL`, `GENERATOR_MODEL` — model overrides
- `NOTION_TOKEN`, `NOTION_DATABASE_ID` — finding auto-filing
- `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`

## Commands

| | |
|---|---|
| `npm run pipeline`   | Onboard a dApp end-to-end: crawl → KG v2 → comprehend → spec-gen |
| `npm run run`        | Run generated specs with self-heal |
| `npm run chat`       | Local CLI to talk to the agent |
| `npm run bot`        | Start Slack + Discord bots |
| `npm run typecheck`  | `tsc --noEmit` |
| `npx tsx scripts/probe-brain.ts`     | 10 probes over `kg-v2.json` (intent→flow, assertion targets, etc) |
| `npx tsx scripts/find-flow.ts`       | Locate flows by intent string |
| `npx tsx scripts/traverse-flow.ts`   | Walk a flow's full state machine |
| `npx tsx scripts/_viz-v2.ts`         | Render `kg-v2.html` interactive graph |

## Pipeline (10 phases — agent loop closes in ONE run)

```
1.  CRAWL                  browser, no LLM       → knowledge-graph.json (raw scaffolding) + scraped/network
2.  UNDERSTAND             LLM, dApp-level       → comprehension.json + structured-docs.json
                              ├─ Comprehender         archetype + summary
                              └─ Doc Structurer       per-doc {topics, rules}
3.  STRUCTURE              LLM, per-module       → modules.json + controls.json
                              ├─ Module Discovery
                              ├─ Control Clustering
                              └─ Control Wiring
4.  DERIVE                 no LLM + 1 LLM batch  → capabilities.json
                              ├─ Capability Derivation graph traversal
                              ├─ Capability Naming     LLM labels (per-module batched)
                              └─ Edge Case Derivation  constraints × caps + heuristic personas
5.  ASSEMBLE BRAIN (skel)  no LLM                → skeleton kg-v2.json
                              ├─ kg-migrate            v1 + sidecars → 4-layer skeleton
                              └─ tech-binder           bind ApiCall/ContractCall/Event
6.  MARKDOWN (preliminary) no LLM                → knowledge/*.md (so explorer agent has docs)
7.  EXPLORE                LLM, live agent       → exploration.json (THIS run)
                              runExecutor walks each module against the skeleton brain
8.  FINALIZE BRAIN         no LLM + 1 LLM batch  → finalized kg-v2.json + kg-validation.json
                              ├─ explorer-ingest       fold THIS-run deltas in
                              ├─ state-extractor       LLM names state machines per flow
                              │                        (sees explorer deltas in prompt)
                              ├─ kg-cleanup            drop superseded skeletons
                              └─ kg-validator          schema + assertion-completeness
9.  MARKDOWN re-emit       no LLM                → knowledge/*.md (with finalized brain)
10. SPEC GEN               no LLM                → tests/<module>/*.spec.ts (v2-enriched)
```

**The agent (`runExecutor`, src/agent/loop.ts) appears in three places:**
- Phase 7 EXPLORE — walks per-module to enrich the brain (build-time)
- `npm run run` → heal-runner — recovers broken specs (run-time)
- `npm run chat` → handler.ts → act mode — handles ad-hoc tasks (run-time)

Same function, three task contexts.

**Two KG artifacts** — by current design, not deliberately:
- `knowledge-graph.json` (Phase 1 output) — flat raw scaffolding consumed by Phases 2–4
- `kg-v2.json` (Phase 8 output) — THE brain, what spec-gen + chat agent + probe-brain consume

Nothing reads `knowledge-graph.json` after Phase 4. Folding crawler output directly into v2 nodes (eliminating the v1 file) is the next architectural cleanup; not done yet.

Skip flags:
- coarse:  `--skip-crawl --skip-comprehend --skip-docs --skip-modules --skip-controls --skip-wiring --skip-capabilities --skip-naming --skip-edges`
- assemble: `--skip-assemble` (both halves) OR `--skip-assemble-skeleton` / `--skip-assemble-finalize`
- finalize: `--skip-states --skip-explorer-ingest --skip-validate`
- live:    `--skip-explore --skip-markdown --skip-markdown-reemit --skip-specgen`

## Folder layout

```
bugdapp-agent/
├── SYSTEM.md             ← end-to-end architecture (read this)
├── scripts/              ← entry points: pipeline, run, chat, bot + probes
├── src/
│   ├── config.ts         ← active dApp + chain registry
│   ├── core/             ← Chromium + MetaMask + LLM + browser/wallet tools
│   ├── chain/            ← viem clients + receipt decode + ABI registry
│   ├── agent/            ← runtime: loop, session, knowledge, prompts, kg-v2, archetypes
│   ├── pipeline/         ← all 18 phases + heal-runner + spec-healer
│   └── chat/             ← intent + matcher + handler + transports (CLI/Slack/Discord)
├── templates/            ← wallet.fixture.ts + playwright.config.ts (copied at gen)
├── metamask-extension/   ← bundled MM (gitignored)
├── data/abis/            ← ABI cache
├── test/                 ← vitest
└── output/<host>/        ← per-dApp brain + tests
    ├── kg-v2.json        ← THE BRAIN (always latest)
    ├── kg-v2/            ← per-crawl snapshots
    ├── kg-validation.json
    ├── kg-v2.html        ← interactive viz
    ├── knowledge/*.md    ← module docs (RAG substrate)
    ├── tests/<module>/   ← Playwright specs
    └── (v1 sidecars)     ← knowledge-graph.json, comprehension.json, modules.json,
                            controls.json, capabilities.json, structured-docs.json
```

## Status (Avantis, 2026-04-30)

- KG v2: **2553 nodes / 12778 edges**, validator green (0 errors / 0 warnings).
- Brain probe: **10/10** passing.
- Specs: **295** Playwright files (288 trade + 7 across other modules), 80 trade specs cite v2 KG state machines + event assertions.
- Chat + act loop verified live on Avantis (browser + wallet connect).
- Self-heal unit tests pass; live heal run pending.
- Transaction signing not yet exercised (needs ~$1 USDC on Base for ZFP 100x).
- Only 1 dApp run end-to-end. Other 19 profiles untouched.

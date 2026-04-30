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

## Pipeline (11 phases)

```
1.  Crawler              browser, no LLM   → knowledge-graph.json + scraped/network/interactions
2.  Comprehender         LLM (Sonnet)      → comprehension.json
3.  Doc Structurer       LLM               → structured-docs.json
4.  Module Discovery     LLM               → modules.json + module-edges.json
5.  Control Clustering   LLM               → controls.json
6.  Control Wiring       LLM               → controls.json (wired)
7.  Capability Derivation no LLM           → capabilities.json (unnamed)
8.  Capability Naming    LLM               → capabilities.json (named)
9.  Edge Case Derivation no LLM            → capabilities.json (edge cases + heuristic personas)
10. KG Assemble          ONE phase, six steps → kg-v2.json + kg-validation.json
      ├─ migrate           no LLM   v1 sidecars → 4-layer skeleton KG
      ├─ tech-binder       no LLM   bind ApiCall/ContractCall/Event onto actions
      ├─ explorer-ingest   no LLM   fold runtime deltas from exploration.json
      ├─ state-extractor   LLM      replace skeleton states with named state machines
      ├─ cleanup           no LLM   drop migrator skeletons LLM superseded
      └─ validator         no LLM   schema + assertion-completeness rules
11. Markdown + Explorer + Spec Gen → knowledge/*.md, exploration.json (next-run input), tests/<module>/*.spec.ts
```

Skip flags reuse cached artifacts:
- pre-assemble:  `--skip-crawl --skip-comprehend --skip-docs --skip-modules --skip-controls --skip-wiring --skip-capabilities --skip-naming --skip-edges`
- assemble:      `--skip-assemble` (whole), or fine-grained `--skip-states --skip-explorer-ingest --skip-validate`
- post-assemble: `--skip-explore --skip-markdown --skip-specgen`

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

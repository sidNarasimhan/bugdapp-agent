# bugdapp-agent

Single-agent Web3 QA system. Give it a dApp URL, it crawls the UI + docs, builds a knowledge graph, generates Playwright specs module-by-module, runs them with a MetaMask fixture, and self-heals failures by stepping in with a browser-driving agent. You can also talk to it on Slack / Discord / CLI to run arbitrary QA tasks on demand.

Full architecture in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

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
- `EXECUTOR_MODEL`, `CHAT_MODEL`, `MATCH_MODEL` — model overrides
- `NOTION_TOKEN`, `NOTION_DATABASE_ID` — finding auto-filing
- `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`

## Commands

| | |
|---|---|
| `npm run pipeline` | Onboard a dApp: crawl → KG → comprehend → spec-gen |
| `npm run run`      | Run generated specs with self-heal |
| `npm run chat`     | Local CLI to talk to the agent |
| `npm run bot`      | Start Slack + Discord bots |
| `npm run typecheck`| `tsc --noEmit` |
| `npm test`         | Vitest |

## Folder layout

```
bugdapp-agent/
├── ARCHITECTURE.md       ← system design + diagrams
├── scripts/              ← 4 entry points: pipeline, run, chat, bot
├── src/
│   ├── config.ts         ← ActiveDApp resolved from comprehension.json
│   ├── core/             ← Chromium + MM + LLM + browser/wallet tools
│   ├── chain/            ← viem + receipt decode + ABI registry
│   ├── agent/            ← the agent: loop, session, knowledge, prompts, archetypes
│   ├── pipeline/         ← crawler, KG, comprehend, spec-gen, heal-runner
│   └── chat/             ← intent, matcher, handler, notion, transports
├── templates/            ← wallet.fixture.ts + playwright.config.ts
├── metamask-extension/   ← bundled MM (gitignored)
├── data/abis/            ← ABI cache
├── test/                 ← vitest
└── output/
    └── developer-avantisfi-com/   ← the Avantis brain (KG + comprehension + specs)
```

## Status

- ✅ Full chat + act loop verified live on Avantis (browser + wallet connect)
- ✅ Self-heal unit tests pass; live heal run pending
- ⏳ Pipeline rebuild end-to-end not yet exercised (pre-built Avantis brain is sufficient for current use)
- ⏳ Transaction signing not yet exercised (needs ~$1 USDC on Base for Avantis ZFP 100x)

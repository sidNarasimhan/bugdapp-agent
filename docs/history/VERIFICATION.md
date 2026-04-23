# Session 1 — Verification Report

**Date:** 2026-04-18
**Goal:** excise Avantis-specific bleed from the active pipeline so the agent works on any dApp.
**Credits spent:** $0.00 (deterministic refactor only — no LLM calls)
**Credits remaining:** $10.02 (unchanged from session start)

## Files changed

| File | What changed | Why |
|---|---|---|
| `src/phases/context.ts` | `TEST_VALUES` no longer hardcodes `leverage`/`collateral`/`price`/`tp`/`sl`; `getTestValue` uses only HTML type hints + email/search heuristics | Crawler was injecting perps-specific numeric values into every dApp's forms |
| `src/phases/context.ts` | Chain-switch now reads `chainHexId` from the dApp profile (was hardcoded to Base `0x2105`) | Crawling an Arbitrum or Ethereum dApp would force-switch to Base and silently fail |
| `src/phases/context.ts` | Docs-keyword scoring broadened from 15 perps terms to ~35 generic web3 terms covering all major archetypes | Non-perps dApp docs were being rejected → empty `docsContent` → LLM had no domain context |
| `src/phases/context.ts` | Privy "(Avantis)" comment generalized | Misleading comment |
| `src/phases/explorer.ts` | Tool schema: `tradingAssets`/`tradingModes` → `entities`/`modes` (with backward-compat read of legacy names) | Schema was baking TradeFi assumptions into the LLM's structured output |
| `src/phases/explorer.ts` | Field descriptions for `states`, `entities`, `modes` now list examples across swap/perps/lending/staking/NFT/bridge | LLM was guided to look for "Long/Short, Market/Limit, ZFP on/off" on every dApp |
| `src/prompts/explorer.ts` | System prompt "deep verification" checklist now generic — categorizes the dApp's domain from crawl+docs, then tests domain-appropriate flows | System prompt was telling the LLM to test perps-specific things (leverage sliders, TP/SL, liquidation price) regardless of dApp class |
| `src/prompts/explorer.ts` | User prompt task list now adaptive: renders actual `navLinks` from the crawl instead of hardcoded "/trade", "/portfolio", "/earn", "/leaderboard", "/referral"; removed Zero Fee Perps + Long/Short + Stop Limit instructions | This was the biggest Avantis leak — the LLM was being told to navigate to Avantis's specific page structure on every dApp |
| `src/agent/nodes/planner.ts` | Rule-3 prompt example: "collateral amount, leverage, prices" → "amounts, numeric configs, entity choices — whatever this dApp's domain requires" | LLM was biased toward perps terminology |

**Nothing deleted from src/*** — both orchestrator paths (CLI/HTTP via `src/index.ts` + `src/server.ts` + `src/orchestrator.ts`, and script via `scripts/run-pipeline.ts` through `src/agent/nodes/*`) share `src/phases/*` as implementation, so the fixes benefit both.

## Cleanup

Deleted (dead dev scratch / stale artifacts):
- Root: `test-crawl.ts`, `test-explore.ts`, `test-launch.ts`, `test-staking-deep.ts`, `test-staking-incentive.ts`, `test-staking-verify.ts`
- Root screenshots: `portfolio-logged-out.png`, `trade-page-order-panel.png`, `trade-page-scrolled.png`
- `output/debug` (empty), `output/dapp-exploration` (empty)
- `output/crawl-test`, `output/explore-test`, `output/staking-incentive-test`, `output/staking-verify` (stale dev crawl artifacts)
- `output/e2e-smoke-local` (stale smoke artifact from 2026-04-11)

Kept:
- `output/_archive_untrusted/` — pre-existing quarantine of overclaim artifacts (per previous CTO's fire)
- `output/developer-avantisfi-com/knowledge-graph.stub-from-fire.bak.json` — post-fire safety backup
- `test/` — real vitest unit tests (6 files, 25 tests)

## Verification (end-to-end, re-run)

### 1. Typecheck
```bash
npx tsc --noEmit
# → clean (zero errors)
```

### 2. Unit tests
```bash
npx vitest run
# → 6 test files passed, 25/25 tests pass
```
Two tests had to be updated (`test/mock-pipeline.test.ts:20`, `test/planner.test.ts:41+55`) because they asserted Avantis-shaped prompt content (`/trade`, `[ref=e1] [button] "Login"`, `"Wallet required: true"`). Updated to assert the generic equivalents (URL, chain, nav-link presence, docs content echoing).

### 3. Spec-gen smoke (cached KGs — no credits, no browser)
```bash
npx tsx scripts/run-spec-gen.ts https://developer.avantisfi.com/trade
# → Avantis: 3 specs regenerated (2 flow specs + adversarial), 17 older specs preserved
npx tsx scripts/run-spec-gen.ts https://app.aave.com
# → Aave: 2 specs (lending + navigation), 14 tests
npx tsx scripts/run-spec-gen.ts https://aerodrome.finance/swap
# → Aerodrome: 2 specs (swap + navigation), 19 tests
```

### 4. Final disk state (measured via grep `^\s*test\(`)
| dApp | Specs | Tests | Notes |
|---|---|---|---|
| developer-avantisfi-com | 20 | 121 | Prior 117-test set intact; +adversarial.spec.ts (4 scenarios) |
| app-aave-com | 3 | 14 | nav(9) + lending(4) + supply-usdc-handcrafted(1) |
| aerodrome-finance | 2 | 19 | nav(15) + swap(4) |
| app-morpho-org | 2 | 20 | nav(16) + lending(4) |
| app-compound-finance | 2 | 7 | nav(3) + lending(4) |
| **Total (47 files, 14 dApps)** | **47** | **230** | was 46 files / 226 tests pre-session; no regressions |

## What's still Avantis-leaky (queued for Session 2+)

- `src/agent/nodes/spec-generator.ts`: `stepToPlaywright()` asset-opener regex `/[A-Z]{3,}[-/]?USD/i` matches perps-style symbols only. Swap dApps use token-pair buttons, lending dApps use per-asset rows. **This is the archetype-aware step-emitter refactor planned for Session 2.**
- `src/agent/nodes/flow-computer.ts`: cross-product flow generation assumes dimensional toggles (Avantis-shape). For swap/lending/staking, produces zero valid flows. **Replaced in Session 2 by archetype-dispatched flow generators.**
- `src/phases/generator.ts` (lines 258-273): legacy module keyword mapping (`trade`/`portfolio`/`earn`/`leaderboard`/`referral`) with perps terms. Used only via the `web3-qa` CLI binary (`runQAAgent`), not via `run-pipeline.ts`. Lower priority — legacy path.
- `src/prompts/planner.ts`: legacy planner prompt has 17 Avantis-specific "Required Test Coverage" items (ZFP, Long/Short, Percentage Buttons, etc.). Used only via `runQAAgent`. Lower priority.
- `src/prompts/generator.ts`, `src/prompts/healer.ts`: legacy, same orchestrator-only path.

## Session 2 preview (not started)

Now that domain assumptions are excised from the perception layer (crawler + explorer), the blocking work for V0 is adding the **reasoning layer** the vision requires:

1. **Comprehension node** (new, LLM, ~$0.10–0.30/dApp): ingests crawl + docs + interactions, emits structured `Comprehension.json` — what this dApp is, primary flows, constraints, risks.
2. **Structured docs extractor** (enhance crawler): section parsing + constraint-table extraction instead of raw-text scraping.
3. **Contract address extractor** (new, deterministic): regex over network traffic + docs for `0x…` addresses, verify on Etherscan/Sourcify, tag by role.

Session 3 wires findings + outreach reports and actually executes specs end-to-end.

## Confidence rating

**Session 1: shipped.** Typecheck clean, unit tests green, spec-gen works on 5 dApps across 3 archetypes (perps/lending/swap), no regression to the 117 Avantis tests. Risk of unintended consequences from the deterministic refactors is low. The remaining Avantis leaks are in paths not currently active (CLI via orchestrator) or require architectural work (flow-computer, step-emitter) that belongs to Session 2.

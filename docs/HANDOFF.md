# bugdapp-agent — handoff

**Status as of 2026-04-18** — cleaned up, ready for manual work.

This doc is the one-page map. Everything below is verified to exist + typecheck + match reality on disk.

---

## What the project actually is

A LangGraph-style pipeline that takes a dApp URL and tries to:

1. Crawl the site + docs + network API traffic (browser, no LLM)
2. Build a knowledge graph from the crawl
3. Reason over it with an LLM ("comprehension")
4. Generate archetype-appropriate Playwright regression specs
5. Run them against the live dApp with a MetaMask fixture
6. Produce per-dApp outreach reports

**What works today:** steps 1–4. Comprehension, spec emission, outreach reports are all deterministic + reproducible from cached crawl data on disk.

**What doesn't work yet:** step 5. The MetaMask wallet fixture has known issues (see "Known bugs" below). No generated spec has been run successfully against a live dApp end-to-end.

---

## Directory layout

```
src/
  agent/
    archetypes/        per-archetype CTA + classifier defaults (perps/swap/lending/...)
    profiles/          per-dApp thin overrides (20+ profiles)
    chain/             on-chain verification (receipt decode, invariants, findings, Anvil, contract extraction)
    nodes/             LangGraph node builders (crawler, kg-builder, comprehension, planner, spec-generator, ...)
    state.ts           KG type definitions + merge reducers + DAppGraph class
  phases/              phase implementations wrapped by agent/nodes (context.ts = crawler, explorer.ts, planner.ts, generator.ts, executor.ts, healer.ts)
  prompts/             LLM prompts per phase (explorer/planner/generator/healer)
  browser/             Chromium launcher, MetaMask setup, wallet tools
  llm/                 OpenRouter client + cost tracker
  chat/                Discord bot + CLI chat interface
  integrations/        Slack/Discord/Linear/Notion exporters
  orchestrator.ts      web3-qa CLI entry (uses src/phases/* directly)
  index.ts             web3-qa CLI bin
  server.ts            HTTP server for queuing runs
scripts/               entry-point scripts (see "How to run")
templates/             copied into output/<dapp>/ at spec-gen time (wallet.fixture.ts, playwright.config.ts)
output/                per-dApp artifacts (see "Output layout")
test/                  vitest unit tests (25 tests, currently green)
metamask-extension/    bundled MetaMask v13.22 extension (loaded into Chromium)
data/abis/             on-disk ABI cache (populated by chain/abi-registry.ts)
```

---

## How to run

### Full loop on a dApp
```bash
npx tsx scripts/live.ts <url>
# or re-run skipping pieces (for tuning):
npx tsx scripts/live.ts <url> --skip-crawl --skip-comprehend
```
Runs: crawl → KG → comprehension → spec-gen → outreach report. Output lands under `output/<hostname>/`.

### Full LangGraph pipeline (more flags)
```bash
npx tsx scripts/run-pipeline.ts --url <url> [--skip-crawler] [--skip-explorer] [--skip-planner] [--stop-after <phase>]
```

### Just comprehension (cheap LLM call, uses cached crawl)
```bash
npx tsx scripts/run-comprehension.ts <hostname>             # one dApp
npx tsx scripts/run-comprehension.ts --all --force          # all 5 real-KG dApps
```

### Just outreach report (no LLM, reads comprehension + KG from disk)
```bash
npx tsx scripts/make-outreach-report.ts <hostname>
```

### Just spec-gen (from valid-flows.json + KG — the old path)
```bash
npx tsx scripts/run-spec-gen.ts <url>
```

### Adversarial scenarios
```bash
npx tsx scripts/run-adversarial.ts <hostname>           # dry-run, no credits
npx tsx scripts/run-adversarial.ts <hostname> --live    # LLM-enriched, ~$0.10
```

### Anvil fork + run the suite against it
```bash
npx tsx scripts/anvil-run.ts <hostname>                 # requires foundry installed
```

### Drift detection (continuous)
```bash
npx tsx scripts/watch.ts <hostname> --baseline          # capture fresh baseline
npx tsx scripts/watch.ts <hostname> --interval 600      # diff every 10min
```

### Multi-dApp batch crawl
```bash
npx tsx scripts/batch-crawl.ts                          # runs default tier-1 set
npx tsx scripts/batch-crawl.ts <host1> <host2>
```

### Tests
```bash
npx tsc --noEmit           # typecheck
npx vitest run             # unit tests (25)
```

---

## Output layout

For each dApp crawled, `output/<hostname>/`:

- `context.json`, `crawl-pages.json` — raw crawl metadata
- `scraped-data.json` — per-page element dump
- `network-raw-apis.json` — intercepted API responses
- `interactions.json` — what happened when crawler clicked every element
- `bundle-analysis.json` — JS bundle test-IDs + error messages + routes
- `knowledge-graph.json` — the built KG (pages/components/flows/assets/constraints/docs/contracts)
- `comprehension.json` — LLM reasoning output (archetype + flows + risks + adversarial targets)
- `test-plan.json` — planner output (if planner ran)
- `tests/*.spec.ts` — generated Playwright specs
- `fixtures/wallet.fixture.ts` — copied from templates/ at gen time
- `fixtures/chain/*.ts` — on-chain verification module
- `OUTREACH.md` — per-dApp pitch report
- `findings/` — per-finding Jam-style bundles (only after real test runs)
- `screenshots/` — crawl screenshots

### Which dApps have real crawl data
Measured on disk:
- `developer-avantisfi-com` — 5 pages, 79 components, 2308 flows, 96 assets, 2 constraints (from Apr 11 restore)
- `app-aave-com` — 5 pages, 85 components, 11 flows
- `aerodrome-finance` — 3 pages, 40 components, 15 flows
- `app-morpho-org` — 1 page, 69 components, 45 flows
- `app-compound-finance` — 4 pages, 23 components, 6 flows

Other directories (`app-gmx-io`, `balancer-fi`, `velodrome-finance`, `app-vertexprotocol-com`, `app-uniswap-org`, `app-pendle-finance`, etc.) have profile scaffolds + stub `knowledge-graph.json` files (0 components) + hand-written `valid-flows.json` — they crashed or weren't crawled. Re-crawling is needed before treating them as real.

---

## Known bugs (blockers to real execution)

### 1. ~~MetaMask seed phrase cutoff during onboarding~~ FIXED (2026-04-18)
**File:** `templates/wallet.fixture.ts` — `fillSeedPhrase` function
**Root cause:** MM 13.22 uses a single `input[data-testid="srp-input-import__srp-note"]` that validates the phrase on real keystrokes. The old code used `textarea.fill()` (bypasses the validator) or `pressSequentially` with a 20ms delay that dropped chars during MM's re-render.
**Fix:** the new `fillSeedPhrase` tries strategies in order — (a) per-word input grid for older MM, (b) `keyboard.type(word) + Space` into the 13.22 single input, (c) clipboard paste via MM's Paste button. Success is confirmed when the Continue button becomes enabled (MM's authoritative validator signal). Fixture was copied to all 20 `output/*/fixtures/wallet.fixture.ts` files.

### 2. MetaMask extension occasionally not loaded by Chromium
**File:** `templates/wallet.fixture.ts` — `walletContext` fixture
**Symptom:** `[Fixture] MetaMask extension page not found` warning, then wallet handshake fails.
**Cause found:** `process.env.METAMASK_PATH` was undefined because Playwright subprocesses don't auto-load `.env` on Windows. Partial fix applied: fixture now reads `.env` directly at top of file (search for `loadEnvFromDotEnv`).
**Verify:** set `METAMASK_PATH` explicitly in `.env` + confirm `manifest.json` exists at that path. `scripts/diag-mm.ts` was the diagnostic (deleted in cleanup) — recreate if needed.

### 3. Tests "pass" when wallet doesn't connect
**File:** `templates/wallet.fixture.ts` — end of `connectWallet` function
**Symptom:** spec runs, wallet never handshakes, test "passes" with CTA = "" / state = unconnected.
**Partial fix applied:** `connectWallet` now throws on handshake failure instead of warning. Verify this landed — search for "wallet handshake did not complete".

### 4. Uniswap wallet connect broken
**Symptom:** MM permissions popup handshake, but page context gets invalidated. Soft-fail added earlier so it doesn't crash, but Uniswap tests report `unconnected`.
**Where:** somewhere in the wallet modal flow specific to Uniswap's "Other wallets" expander.

### 5. Comprehension produces shallow coverage
**File:** `src/agent/nodes/comprehension.ts` + `scripts/run-comprehension.ts`
**Symptom:** 2–3 primary flows + 2–3 edge cases per dApp. Real dApp QA requires 50+ tests (per-asset × per-action × per-boundary).
**Fix direction:** multi-round LLM (one call per module/constraint/asset group) + post-comprehension dimensional enumeration.

### 6. GMX / Vertex / Balancer / Velodrome crawls errored on Apr 13
**Where:** `output/batch-crawl-report.json` had the error logs (deleted in cleanup). Re-run `scripts/batch-crawl.ts <host>` for each.
**Causes:** unknown — likely MM wallet-connect modal variants not covered by the fixture.

---

## Environment setup

`.env` keys (all set on your machine):
- `SEED_PHRASE` — MetaMask test wallet seed
- `OPENROUTER_API_KEY` — for LLM calls
- `METAMASK_PATH` — `X:\bugdapp-agent\metamask-extension` (bundled, MV3 v13.22)
- `FOUNDRY_BIN` — `C:\Users\sidha\.foundry\bin` (Anvil installed there; not in PATH by default — export if using scripts/anvil-run.ts)

Test wallet on Base: `0xEBd478457e5555FB49683874925ed1cBBB987Ee6`
Current balance (2026-04-18): ~$0.70 ETH + $1.98 USDC — enough for gas + small swap, not enough for Avantis ($100 min position).

OpenRouter credits (2026-04-18): ~$10.01 remaining.

---

## Sessions 1–3 change log

If you want to review what was changed recently (before the cleanup):
- `output/VERIFICATION.md` — Session 1 changes (removing Avantis-specific string bleed from prompts, fixtures, categorizers)
- `output/SESSION2-VERIFICATION.md` — Session 2 (added comprehension LLM reasoning + structured docs extraction + contract address extraction)
- `output/SESSION3-VERIFICATION.md` — Session 3 (comprehension-driven spec gen + outreach report generator + live runner)
- `output/STATE.md` — Apr 11 ground-truth snapshot from the previous CTO (pre-sessions)

All three sessions added architecture + plumbing. **None successfully ran a spec against a live dApp.** That's the gap between this and "actually works".

---

## Recommended order of work if picking up manually

1. **Fix the seed phrase cutoff** in `templates/wallet.fixture.ts`. Verify by completing MM onboarding end-to-end (no dApp, just onboard + unlock).
2. **Get one spec to run successfully against Aerodrome.** Complete a real swap tx. Produce a real finding bundle. Don't move past this.
3. **Once step 2 works**, the comprehension coverage problem (issue #5 above) becomes the next real blocker. The fix is 4+ hours of prompt + enumeration work.
4. **Re-crawl the 4 failed dApps** (GMX, Vertex, Balancer, Velodrome) once the fixture is solid.

---

## Dead code notes

The audit identified these nodes as wired-in-but-dead (safe to delete if you want to shrink the surface):
- `src/agent/nodes/adversarial.ts` — generates scenarios, stores in state, spec-gen never consumes them on legacy path (new comprehension-spec-gen does, via a different channel)
- `src/agent/nodes/drift-detector.ts` — never called by run-pipeline.ts
- `src/agent/nodes/matrix-filler.ts` — expects old planner shape; broken under current shape
- `src/agent/nodes/flow-validator.ts` — walks flows but only pass/fail, no reasoning

Left in place because removing them requires touching `scripts/run-pipeline.ts` imports. Low priority.

Two parallel entry paths also exist (both use `src/phases/*` as shared impl):
- `src/index.ts` → `src/orchestrator.ts` (the `web3-qa` CLI binary)
- `scripts/run-pipeline.ts` → `src/agent/nodes/*` (the LangGraph path)

If you want to simplify, pick one and delete the other.

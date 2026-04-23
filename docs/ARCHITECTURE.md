# Web3 QA Agent — Architecture & Current State

**Last updated:** 2026-03-31

## Overview

A LangGraph JS agent that takes a dApp URL, explores it autonomously, and generates Playwright test specs. Built on `@langchain/langgraph` 1.2.6 with OpenRouter for LLM calls.

```
npm run agent -- --url https://any-dapp.com/
```

## Pipeline

```
START
  │
  ▼
[Crawler] ──── no LLM, $0, ~2 min
  │ Outputs: scraped pages, elements, interactions, flows,
  │          network APIs, docs, bundle analysis
  │ Stores to: state.crawlData + state.dappModel (flat arrays)
  │ Persists to: output/{dapp}/scraped-data.json, context.json, etc.
  │
  ▼
[Context Builder] ──── no LLM, generates text summary
  │ Reads: state.dappModel
  │ Outputs: dApp profile (~10K chars of readable summary)
  │ Stores to: state.crawlData.dappProfile
  │
  ▼
[Explorer] ──── LLM agent loop, DeepSeek V3.2, 150 max iterations
  │ Has: 15 browser+wallet tools + 2 reporting tools
  │ Reads: state.dappModel, dApp profile
  │ Outputs: discovered flows + edge cases via report_flow/report_edge_case
  │ Stores to: state.dappModel.flows + state.dappModel.edgeCases
  │
  ▼
[Planner] ──── single LLM call per module, DeepSeek V3.2
  │ Reads: state.dappModel (components, flows, edge cases, constraints, features, assets, docs)
  │ Outputs: test plan JSON (suites with test cases)
  │ Stores to: state.testPlan
  │
  ▼
[Generator] ──── single LLM call per suite, Qwen3 Coder
  │ Reads: state.testPlan + state.dappModel (selectors, flows)
  │ Outputs: .spec.ts Playwright files
  │ Stores to: state.specFiles + writes files to disk
  │
  ▼
[Executor] ──── no LLM, runs `npx playwright test`
  │ Reads: state.specFiles
  │ Outputs: test results (pass/fail per test)
  │ Stores to: state.testResults
  │
  ▼
[Conditional: pass rate >= 80%?]
  │
  ├─ YES → [Report] → END
  │
  └─ NO → [Healer] ──── single LLM call per failing spec, Qwen3 Coder
           │ Reads: state.testResults + spec code + errors
           │ Outputs: fixed .spec.ts files
           │
           └─ [Conditional: retries left?]
                ├─ YES → back to [Generator]
                └─ NO → [Report] → END
```

## File Structure

```
src/agent/
├── state.ts              ─ State types (DAppModel, TestPlan, TestResult, etc.)
├── tools.ts              ─ 15 DynamicStructuredTools (browser + wallet)
├── graph.ts              ─ LangGraph StateGraph with nodes, edges, conditionals
├── index.ts              ─ CLI entry point (commander)
└── nodes/
    ├── crawler.ts         ─ Wraps existing crawlDApp, populates DAppModel
    ├── context-builder.ts ─ Generates human-readable dApp profile from DAppModel
    ├── explorer.ts        ─ LLM agent loop with browser/wallet/reporting tools
    ├── module-segmenter.ts─ Groups components into testable modules
    ├── planner.ts         ─ Per-module LLM call to generate test plans
    ├── generator.ts       ─ Per-suite LLM call to write .spec.ts files
    ├── executor.ts        ─ Runs specs via npx playwright test
    └── healer.ts          ─ Fixes failing specs via LLM

src/browser/
├── launcher.ts           ─ Launches Chromium with MetaMask via Playwright
├── metamask-setup.ts     ─ MetaMask onboarding (seed import, password, dismiss)
├── tools.ts              ─ Browser tool implementations (click, type, snapshot, etc.)
├── wallet.ts             ─ Wallet tool implementations (approve, sign, confirm, etc.)
├── network.ts            ─ Network request interception during crawl
└── bundle.ts             ─ JS bundle analysis (testIds, routes, error messages)

src/phases/
├── context.ts            ─ The crawler (1100+ LoC, exhaustive page scraping)
├── gap-analysis.ts       ─ Pattern-based flow detection from crawl data
└── (other old phases — not used by new agent pipeline)

templates/
├── wallet.fixture.ts     ─ Playwright test fixture with MetaMask support
└── playwright.config.ts  ─ Playwright config for generated tests
```

---

## Data Model (what we call "KnowledgeGraph" but is really flat arrays)

### Current TypeScript types in state.ts:

```typescript
interface KnowledgeGraph {
  pages: KGPage[];            // 5 for Avantis
  components: KGComponent[];  // ~72 (deduplicated)
  actions: KGAction[];        // ~54 interaction records
  flows: KGFlow[];            // ~18 (4 crawler + ~13 explorer)
  edgeCases: KGEdgeCase[];    // ~7 from explorer
  testCases: KGTestCase[];    // populated by planner
  edges: KGEdge[];            // UNUSED — never queried
  features: KGFeature[];      // ~9 from docs
  assets: KGAsset[];          // ~96 from API interception
  dropdownOptions: KGDropdownOption[];  // ~3 (Market/Limit/Stop)
  docSections: KGDocSection[];          // ~15 parsed from docs
  apiEndpoints: KGApiEndpoint[];        // ~10 significant ones
  constraints: KGConstraint[];          // extracted from docs
}
```

### CRITICAL PROBLEM: This is NOT a graph

There are no real relationships between entities. The `edges` array exists but nothing writes to it or reads from it meaningfully. Components don't know which actions they trigger. Actions don't know what components they reveal. There is no way to traverse from "Login button" → "Auth Modal" → "MetaMask option" → "Wallet Connected" → "Trading Form enabled."

**The data to build real relationships EXISTS in the crawler output** (interactions say "click X → Y elements appeared") **but is stored as a flat list, not as connected edges.**

---

## What Each Phase Collects

### Phase 1: Crawler (context.ts)

**Input:** dApp URL + browser with MetaMask
**Cost:** $0 (no LLM)
**Time:** ~2-3 minutes

**What it does:**
1. Navigates to dApp URL
2. Connects wallet (Login → MetaMask → SIWE)
3. Discovers navigation links
4. For each page:
   - Scrapes ALL interactive elements via `getByRole` queries
   - Clicks every button, records DOM before/after (what appeared/disappeared)
   - Types test values into inputs
   - Opens every dropdown, records options
   - Toggles every switch
   - Follows recursive interactions up to depth 2
   - Captures localStorage/sessionStorage
5. Intercepts ALL network requests (API responses, price feeds, configs)
6. Scrapes documentation from docs site (auto-detected or `docs.{hostname}`)
7. Analyzes JS bundles for testIds, routes, error messages
8. Builds coverage map (what was interacted with, what was missed)

**Raw output files:**

| File | Size | Contents |
|------|------|----------|
| `scraped-data.json` | ~41KB | Per-page: elements (role, name, disabled), dropdowns, localStorage, links |
| `context.json` | ~32KB | Title, description, docsContent (31K chars), chain, features list |
| `interactions.json` | ~26KB | 54 records: page, element, action, DOM changes (appeared/disappeared), success |
| `discovered-flows.json` | ~7KB | 4 multi-step click sequences the crawler found |
| `network-raw-apis.json` | ~2.3MB | Full API response bodies keyed by URL path |
| `network-data.json` | ~3KB | Summary: asset list, market configs, API endpoint list |
| `bundle-analysis.json` | ~11KB | 55 testIds, 95 API endpoints, 33 routes, 955 error messages |

**What goes into the DAppModel (state):**

| DAppModel field | Source | What's stored |
|-----------------|--------|---------------|
| `pages` | scraped-data.json | 5 pages with URL, name, element count |
| `components` | scraped-data.json elements | 72 components (deduplicated, shared nav removed) with role, name, Playwright selector |
| `actions` | interactions.json | 54 records: what clicking/typing each element does |
| `flows` | discovered-flows.json | 4 shallow flows (2-3 steps each) |
| `features` | context.json features + doc matching | 9 features with descriptions from docs |
| `assets` | network-raw-apis.json (pairInfos) | 96 trading pairs with group and maxLeverage |
| `dropdownOptions` | scraped-data.json dropdownContents | 3 options (Market, Limit, Stop limit) |
| `docSections` | context.json docsContent (parsed) | ~15 sections with title, content, keywords |
| `apiEndpoints` | network-raw-apis.json (filtered) | ~10 significant endpoints with descriptions |
| `constraints` | context.json docsContent (regex extraction) | Leverage limits, liquidation thresholds, market hours, etc. |
| `edges` | **NOTHING** | Array exists but is barely populated |
| `edgeCases` | **NOTHING from crawler** | Only populated by explorer |
| `testCases` | **NOTHING from crawler** | Only populated by planner |

### Phase 2: Context Builder (context-builder.ts)

**Input:** DAppModel from state
**Cost:** $0
**Time:** instant

Generates a ~10K char human-readable dApp profile text. Includes:
- Page list
- Features with descriptions
- Assets by group
- Component summary per page with selectors
- Dropdown options
- Discovered flows with steps
- Constraints with test implications
- Key interactions
- Doc section summaries
- API endpoint list

This text is stored in `state.crawlData.dappProfile` and sent to the explorer and planner as context.

### Phase 3: Explorer (explorer.ts)

**Input:** DAppModel + dApp profile + live browser
**Cost:** ~$0.50-1.00 (DeepSeek V3.2, 142 iterations)
**Time:** ~5-10 minutes

**What it is:** The only REAL agent — LLM in a loop with tools, making decisions.

**Tools available (17 total):**
- `browser_navigate` — go to URL
- `browser_snapshot` — get accessibility tree with [ref=eN] identifiers
- `browser_click` — click element by ref
- `browser_type` — type into input by ref
- `browser_screenshot` — take screenshot
- `browser_evaluate` — run JS in page
- `browser_press_key` — press keyboard key
- `browser_scroll` — scroll up/down
- `browser_wait` — wait for text or timeout
- `wallet_approve_connection` — approve MetaMask + SIWE
- `wallet_sign` — approve signature
- `wallet_confirm_transaction` — confirm tx
- `wallet_switch_network` — switch chain
- `wallet_reject` — reject request
- `wallet_get_address` — get connected address
- `report_flow` — **structured output: record a discovered user flow into DAppModel**
- `report_edge_case` — **structured output: record an edge case into DAppModel**

**Anti-loop mechanisms:**
- Action history tracking — detects duplicate actions (same tool + same args ≥ 2 times → warning)
- Progress tracking — counts new pages visited, components interacted with, flows reported
- Auto-stop — 10 consecutive iterations with no progress → forces stop
- Coverage injection — every 20 iterations, shows progress % to the LLM
- Budget warning — at 10 iterations remaining, tells LLM to wrap up

**What it auto-does before the loop:**
- Navigates to dApp URL
- Checks if wallet is connected via `window.ethereum.selectedAddress`
- If not connected: clicks Login → Continue with wallet → MetaMask → approves

**What goes into DAppModel:**
- `flows` — via `report_flow` tool (13 flows in last run)
- `edgeCases` — via `report_edge_case` tool (7 edge cases in last run)

**Example explorer discoveries from last run:**
- "Zero collateral disables Place Order button"
- "Negative values auto-correct to positive"
- "Excessive leverage (1000x) disables submit button"
- "Negative limit prices accepted but disable submission"
- "NET PNL button toggles to GROSS PNL"
- Complete trade flow: Enable → collateral → Place Order → Confirm → Position opens
- Close all positions flow with confirmation modal

### Phase 4: Planner (planner.ts)

**Input:** DAppModel + dApp profile
**Cost:** ~$0.10-0.30 (one call per module)
**Time:** ~2-5 minutes

**Module segmentation:** Before planning, `module-segmenter.ts` groups components by functional area:
- Pages with both forms + tabs get split into "Main" and "Views" modules
- Pages with only one type of content stay as one module
- Shared nav components become a "Navigation" module

**Per module, the planner LLM receives:**
- dApp profile (3K chars)
- Module components with Playwright selectors
- ALL flows (not filtered — so cross-page flows aren't lost)
- ALL edge cases
- Module features
- Module assets (if relevant)
- Module constraints with test implications
- Dropdown options
- Interaction records

**Output:** JSON test plan with suites and test cases, each having:
- ID, name, steps (text descriptions), expectedOutcome, requiresFundedWallet, priority

**What goes into state:** `state.testPlan` + `state.dappModel.testCases`

### Phase 5: Generator (generator.ts)

**Input:** state.testPlan + DAppModel
**Cost:** ~$0.30-0.60 (Qwen3 Coder, one call per suite)
**Time:** ~2-3 minutes

**Per suite:**
- Builds selector reference from DAppModel components
- Includes interaction data for assertions
- Includes flow details from DAppModel
- LLM generates complete .spec.ts file

**What it does:**
- Copies `wallet.fixture.ts` template to output/fixtures/
- Copies `playwright.config.ts` to output/
- Symlinks node_modules
- Creates package.json
- Writes .spec.ts files to output/tests/

**Output:** File paths in `state.specFiles`

### Phase 6: Executor (executor.ts)

**Input:** state.specFiles
**Cost:** $0
**Time:** varies (up to 5 min per spec)

Runs `npx playwright test` per spec file with:
- `SEED_PHRASE` env var
- `METAMASK_PATH` pointing to extension
- `USER_DATA_DIR` for dedicated test browser profile
- JSON reporter for parsing results

**Output:** `state.testResults` array of pass/fail per test

### Phase 7: Healer (healer.ts)

**Input:** Failed test results + spec code
**Cost:** ~$0.05-0.10 per failing file (Qwen3 Coder)

Reads error message + spec code, LLM rewrites the fix, writes back to disk.

**Output:** Fixed spec files + new edge cases added to DAppModel

---

## LangGraph State

All phases share state via LangGraph `Annotation.Root`:

```typescript
AgentState = {
  messages: BaseMessage[]        // LangGraph message history
  knowledgeGraph: KnowledgeGraph // THE DAPP MODEL (misnamed)
  crawlData: any                 // Raw crawler output + dApp profile
  testPlan: TestPlan | null      // From planner
  specFiles: string[]            // File paths from generator
  testResults: TestResult[]      // From executor
  iteration: number              // Current heal/retry iteration
  maxIterations: number          // Cap (default 3)
  config: { url, seedPhrase, apiKey, outputDir, models... }
}
```

Each node receives full state, returns partial updates. Reducers handle merging:
- `knowledgeGraph` — merges by ID (deduplicates)
- `specFiles` — appends (deduplicates by Set)
- `testResults` — overwrites (latest run)
- `messages` — appends via messagesStateReducer

---

## Models (OpenRouter)

| Agent | Model | Price (in/out per 1M tokens) |
|-------|-------|-----|
| Explorer | deepseek/deepseek-v3.2 | $0.26 / $0.38 |
| Planner | deepseek/deepseek-v3.2 | $0.26 / $0.38 |
| Generator | qwen/qwen3-coder | $0.22 / $1.00 |
| Healer | qwen/qwen3-coder | $0.22 / $1.00 |

---

## What Works (verified in live runs)

- Crawler: 5 pages, 72 components (deduped), 54 interactions, 96 assets, 32K docs ✅
- Context builder: 10K char profile ✅
- Explorer: 142 iterations, 13 flows, 7 edge cases, structured output ✅
- Explorer anti-loop: stops naturally when done, doesn't hit 150 cap ✅
- Explorer wallet: auto-connects before loop starts ✅
- Module segmentation: 5 functional modules detected ✅
- Planner: 48 tests across 5 modules ✅
- Generator: writes .spec.ts files to disk ✅
- Feedback loop: executor → healer → retry cycle ✅

## What's Broken / Not Verified

- **Executor fixture** — MetaMask onboarding in test subprocess not tested
- **DAppModel is NOT a real graph** — no traversable relationships, can't discover user flows programmatically
- **Planner produces shallow tests** — no way to automatically compose multi-step flows from flat component lists
- **Checkpointer disabled** — crashes lose all progress
- **Only tested on Avantis** — genericness not verified

## Critical Gap: No Real Graph

The DAppModel stores:
```
Component: button "Login"
Action: click "Login" → 9 elements appeared: ["Continue with wallet", "MetaMask", "Google", ...]
Component: button "Continue with wallet"
Action: click "Continue with wallet" → 3 elements appeared: ["MetaMask", "Coinbase", ...]
```

But there is NO edge connecting `Login → Auth Modal → Continue with wallet → Wallet Selector → MetaMask`. The data to build these edges EXISTS in the interaction records. We just never built the adjacency graph.

If we built a real graph from interaction data:
```
Login --[click reveals]--> Auth Modal
Auth Modal --[contains]--> Continue with wallet
Continue with wallet --[click reveals]--> Wallet Selector
Wallet Selector --[contains]--> MetaMask
MetaMask --[click triggers]--> wallet_approve_connection
```

Then we could TRAVERSE it to find ALL multi-step user flows programmatically — no LLM guessing needed. This is the single biggest improvement that would fix test quality.

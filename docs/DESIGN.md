# Web3 QA Agent — Design Document

## What This Is

A standalone Node.js program that autonomously tests any Web3 dApp.

```
node qa-agent.js --url https://app.avantis.xyz --seed "mnemonic..." --api-key sk-or-...
```

**Input:** dApp URL + wallet seed + OpenRouter API key
**Output:** Test report with pass/fail results, screenshots, discovered bugs

## Architecture

```
qa-agent.js (CLI entry point)
  │
  ├── 1. CONTEXT phase      — scrape docs, no LLM, no browser
  ├── 2. EXPLORE phase       — LLM agent loop with browser + wallet
  ├── 3. PLAN phase          — single LLM call, no browser
  ├── 4. GENERATE phase      — single LLM call per test, no browser
  ├── 5. EXECUTE phase       — npx playwright test, no LLM
  └── 6. HEAL phase          — LLM reads errors, edits files, no browser
```

## File Structure

```
packages/qa-agent/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # CLI entry point
│   ├── orchestrator.ts       # Runs all phases in sequence
│   ├── config.ts             # Types + defaults
│   │
│   ├── llm/
│   │   ├── openrouter.ts     # OpenRouter client (copied from executor)
│   │   └── cost-tracker.ts   # Token/cost tracking (copied from executor)
│   │
│   ├── browser/
│   │   ├── launcher.ts       # Dappwright bootstrap (launch browser + MetaMask)
│   │   ├── tools.ts          # Browser tool functions (navigate, click, type, snapshot, screenshot)
│   │   └── wallet.ts         # Wallet tool functions (approve, sign, confirm, switch network)
│   │
│   ├── phases/
│   │   ├── context.ts        # Phase 1: Scrape docs
│   │   ├── explorer.ts       # Phase 2: LLM-driven dApp exploration
│   │   ├── planner.ts        # Phase 3: Generate test plan from exploration
│   │   ├── generator.ts      # Phase 4: Generate Playwright spec files
│   │   ├── executor.ts       # Phase 5: Run specs with playwright test
│   │   └── healer.ts         # Phase 6: Fix failing tests
│   │
│   ├── prompts/
│   │   ├── explorer.ts       # System + user prompts for explorer agent
│   │   ├── planner.ts        # Prompt for test plan generation
│   │   ├── generator.ts      # Prompt for spec file generation
│   │   └── healer.ts         # Prompt for fixing test failures
│   │
│   └── types.ts              # Shared types
│
├── test/
│   ├── mocks/
│   │   ├── mock-llm.ts       # Fake OpenRouter that returns scripted responses
│   │   └── mock-browser.ts   # Fake page/context for unit tests
│   ├── tools.test.ts         # Test browser + wallet tool functions
│   ├── explorer.test.ts      # Test explorer with mock LLM + real browser
│   ├── planner.test.ts       # Test planner with mock LLM
│   ├── generator.test.ts     # Test generator output format
│   └── pipeline.test.ts      # Full pipeline with mocks
│
└── output/                   # Generated at runtime
    └── {dapp-name}/
        ├── context.json      # Scraped docs + metadata
        ├── exploration.json  # State graph from explorer
        ├── test-plan.md      # Generated test plan
        ├── specs/            # Generated .spec.ts files
        ├── screenshots/      # Screenshots from exploration + test runs
        └── report.json       # Final test report
```

## Phase Details

### Phase 1: CONTEXT (no LLM, no browser)

**Purpose:** Gather documentation and metadata about the dApp before touching the browser.

**How:**
1. Fetch the dApp URL, extract `<title>`, `<meta>` tags, any docs links
2. If docs URL found (common patterns: docs.*, /docs, /help), fetch and extract text
3. Save as `context.json`:
   ```json
   {
     "url": "https://app.avantis.xyz",
     "title": "Avantis - Perpetual Trading",
     "description": "...",
     "docsContent": "extracted docs text...",
     "chain": "Base",
     "features": ["trading", "LP vault", "referrals"]
   }
   ```

**Cost:** $0
**Time:** ~5 seconds

### Phase 2: EXPLORE (LLM agent loop + browser + wallet)

**Purpose:** Connect wallet, navigate every page, interact with every element, build a complete map of the dApp.

**How:**
This is the core agent loop. The LLM drives the browser:
1. Navigate to the dApp
2. Take snapshot → LLM sees all elements
3. LLM decides what to interact with
4. Execute the action → take new snapshot
5. Repeat until all pages and interactive elements are explored

**Agent loop structure:**
```
system prompt: "You are exploring a Web3 dApp. Your job is to..."
tools: [browser_navigate, browser_snapshot, browser_click, browser_type,
        browser_screenshot, browser_evaluate, browser_press_key,
        wallet_approve_connection, wallet_sign, wallet_confirm_transaction,
        wallet_switch_network, wallet_get_address,
        exploration_complete]
```

The LLM calls `exploration_complete` when it's visited all pages and discovered all interactive elements. Its output is a structured exploration report.

**Output:** `exploration.json`
```json
{
  "pages": [
    {
      "url": "/trade?asset=BTC-USD",
      "name": "Trade",
      "snapshot": "... accessibility tree ...",
      "screenshotPath": "screenshots/trade.png",
      "interactiveElements": [
        { "ref": "e5", "role": "button", "name": "Login", "testId": "login-button" },
        { "ref": "e12", "role": "tab", "name": "Long" },
        ...
      ],
      "walletRequired": true
    },
    ...
  ],
  "connectedState": {
    "address": "0x...",
    "network": "Base",
    "chainId": "0x2105"
  },
  "connectFlow": [
    "Click Login button [testid=login-button]",
    "Click 'Continue with a wallet'",
    "Click 'MetaMask'",
    "Call wallet_approve_connection"
  ],
  "navigationLinks": ["Trade", "Portfolio", "Earn", "Leaderboard", "Referral"]
}
```

**Model:** anthropic/claude-sonnet-4 (needs intelligence)
**Cost:** ~$0.50-1.00 (30-50 LLM calls)
**Time:** ~3-5 minutes

### Phase 3: PLAN (single LLM call, no browser)

**Purpose:** Generate a comprehensive test plan from the exploration data.

**How:**
One big LLM call with:
- The full exploration.json
- The context.json (docs)
- Instructions to generate a complete test matrix

**Prompt strategy:**
```
You are a senior QA engineer for Web3 dApps.

Here is the complete exploration of this dApp:
{exploration.json}

Here is the documentation:
{context.json}

Generate a comprehensive test plan with these categories:
1. Critical paths (wallet connection, main user flows)
2. Feature interactions (combinations of features)
3. Error handling (insufficient funds, wrong network, rejected tx)
4. Navigation (all pages load correctly)
5. State management (wallet persists, positions update)

For each test case:
- Title
- Category
- Steps (using exact element refs/selectors from exploration)
- Expected outcome
- Whether it requires funded wallet
- Whether it's parameterizable (e.g., same flow for BTC/ETH/SOL)

Output as JSON.
```

**Output:** `test-plan.md` + `test-plan.json`

**Model:** anthropic/claude-sonnet-4
**Cost:** ~$0.10-0.20 (one big call with lots of context)
**Time:** ~30 seconds

### Phase 4: GENERATE (one LLM call per test suite, no browser)

**Purpose:** Generate runnable Playwright spec files.

**How:**
For each test suite in the plan, one LLM call:
- Input: test cases for that suite + exploration data + wallet fixture API
- Output: complete .spec.ts file

The LLM is given the wallet fixture API as context:
```typescript
// Available imports:
import { test, expect, raceApprove, raceSign, raceConfirmTransaction } from '../../fixtures/wallet.fixture';

// Fixtures available in each test:
// - wallet: Dappwright wallet API (wallet.switchNetwork('Base'))
// - page: Playwright Page object
// - context: BrowserContext with MetaMask loaded
```

**Output:** `specs/*.spec.ts` files

**Model:** anthropic/claude-sonnet-4 (needs good code quality)
**Cost:** ~$0.30-0.50 (one call per test suite, ~5-8 suites)
**Time:** ~1-2 minutes

### Phase 5: EXECUTE (no LLM)

**Purpose:** Run the generated specs.

**How:**
```bash
SEED_PHRASE="..." npx playwright test specs/ --reporter=json --timeout=180000
```

Parse the JSON reporter output to get pass/fail per test.

**Output:** test results JSON
**Cost:** $0
**Time:** ~5-15 minutes (depends on number of tests)

### Phase 6: HEAL (LLM reads errors, edits files, reruns)

**Purpose:** Fix failing tests and rerun.

**How:**
For each failing test:
1. Read the error message + stack trace
2. Read the spec file
3. One LLM call: "This test failed with this error. Here's the spec code. Fix it."
4. Write the fixed spec
5. Rerun just that test
6. Max 2 heal attempts per test

**Model:** anthropic/claude-sonnet-4
**Cost:** ~$0.05 per failing test
**Time:** ~30 seconds per fix

## Browser Tools (plain functions, not MCP)

Adapted from `packages/executor/src/agent/tools/browser-tools.ts`.

```typescript
// browser/tools.ts

export interface BrowserContext {
  page: Page;
  context: PlaywrightBrowserContext;
  snapshotRefs: Map<string, SnapshotRef>;
  screenshotDir: string;
}

export async function browserNavigate(ctx: BrowserContext, url: string): Promise<string>
export async function browserSnapshot(ctx: BrowserContext): Promise<string>
export async function browserClick(ctx: BrowserContext, ref: string): Promise<string>
export async function browserType(ctx: BrowserContext, ref: string, text: string): Promise<string>
export async function browserScreenshot(ctx: BrowserContext, name: string): Promise<string>
export async function browserEvaluate(ctx: BrowserContext, expression: string): Promise<string>
export async function browserPressKey(ctx: BrowserContext, key: string): Promise<string>
export async function browserScroll(ctx: BrowserContext, direction: 'up' | 'down'): Promise<string>
export async function browserWait(ctx: BrowserContext, opts: { text?: string; timeout?: number }): Promise<string>
```

## Wallet Tools (plain functions)

Adapted from `packages/executor/src/agent/tools/wallet-tools.ts` and `dappwright-test/fixtures/wallet.fixture.ts`.

```typescript
// browser/wallet.ts

export interface WalletContext {
  wallet: Dappwright;
  context: PlaywrightBrowserContext;
  page: Page;
}

export async function walletApproveConnection(ctx: WalletContext, skipSiwe?: boolean): Promise<string>
export async function walletSign(ctx: WalletContext): Promise<string>
export async function walletConfirmTransaction(ctx: WalletContext): Promise<string>
export async function walletSwitchNetwork(ctx: WalletContext, networkName: string): Promise<string>
export async function walletReject(ctx: WalletContext): Promise<string>
export async function walletGetAddress(ctx: WalletContext): Promise<string>
```

## Agent Loop (for Explorer phase)

Adapted from `packages/executor/src/agent/agent-loop.ts`.

The explorer uses the same loop pattern:
1. Build system prompt + tools list
2. Call OpenRouter
3. Parse response for tool calls
4. Execute tools, collect results
5. Feed results back as tool_result messages
6. Repeat until `exploration_complete` is called

```typescript
// phases/explorer.ts

export async function runExplorer(
  browserCtx: BrowserContext,
  walletCtx: WalletContext,
  contextData: ContextData,
  config: QAConfig,
): Promise<ExplorationResult> {
  const client = createOpenRouterClient(config.apiKey);
  const tools = [...browserToolDefs, ...walletToolDefs, explorationCompleteTool];
  const messages = [{ role: 'user', content: buildExplorerPrompt(contextData) }];

  while (apiCalls < config.maxExplorerCalls) {
    const response = await client.messages.create({ ... });
    // ... same tool routing pattern as agent-loop.ts ...
    // Break when exploration_complete is called
  }

  return explorationResult;
}
```

## Tool Definitions for LLM

The LLM needs to know what tools are available. These are passed as the `tools` parameter in the API call:

```typescript
const BROWSER_TOOL_DEFS = [
  { name: 'browser_navigate', description: 'Navigate to a URL', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_snapshot', description: 'Get accessibility snapshot with [ref=eN] elements', input_schema: { type: 'object', properties: {} } },
  { name: 'browser_click', description: 'Click element by ref', input_schema: { type: 'object', properties: { ref: { type: 'string' }, description: { type: 'string' } }, required: ['ref'] } },
  { name: 'browser_type', description: 'Type into input by ref', input_schema: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' } }, required: ['ref', 'text'] } },
  { name: 'browser_screenshot', description: 'Take screenshot', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'browser_evaluate', description: 'Execute JavaScript', input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'browser_press_key', description: 'Press keyboard key', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'browser_scroll', description: 'Scroll page', input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] } },
  { name: 'browser_wait', description: 'Wait for text or timeout', input_schema: { type: 'object', properties: { text: { type: 'string' }, timeout: { type: 'number' } } } },
];

const WALLET_TOOL_DEFS = [
  { name: 'wallet_approve_connection', description: 'Approve MetaMask connection + SIWE', input_schema: { type: 'object', properties: { skipSiwe: { type: 'boolean' } } } },
  { name: 'wallet_sign', description: 'Approve signature request', input_schema: { type: 'object', properties: {} } },
  { name: 'wallet_confirm_transaction', description: 'Confirm on-chain transaction', input_schema: { type: 'object', properties: {} } },
  { name: 'wallet_switch_network', description: 'Switch MetaMask network', input_schema: { type: 'object', properties: { networkName: { type: 'string' } }, required: ['networkName'] } },
  { name: 'wallet_reject', description: 'Reject pending request', input_schema: { type: 'object', properties: {} } },
  { name: 'wallet_get_address', description: 'Get connected wallet address', input_schema: { type: 'object', properties: {} } },
];

const EXPLORER_CONTROL_DEFS = [
  { name: 'exploration_complete', description: 'Call when you have explored all pages and elements', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
];
```

## LLM Integration

**Client:** Reuse `openrouter-client.ts` from executor (Anthropic SDK adapter over OpenRouter).

**Models (configurable via env/CLI):**
- Explorer: `EXPLORER_MODEL` (default: `anthropic/claude-sonnet-4`)
- Planner: `PLANNER_MODEL` (default: `anthropic/claude-sonnet-4`)
- Generator: `GENERATOR_MODEL` (default: `anthropic/claude-sonnet-4`)
- Healer: `HEALER_MODEL` (default: `anthropic/claude-sonnet-4`)

**Cost tracking:** Reuse `cost-tracker.ts` with updated pricing for Claude Sonnet.

## Config

```typescript
interface QAConfig {
  // Required
  url: string;                    // dApp URL
  seedPhrase: string;             // Wallet mnemonic
  apiKey: string;                 // OpenRouter API key

  // Optional
  outputDir: string;              // Default: ./output/{dapp-name}
  headless: boolean;              // Default: false
  metamaskVersion: string;        // Default: dappwright recommended

  // Model overrides
  explorerModel: string;          // Default: anthropic/claude-sonnet-4
  plannerModel: string;
  generatorModel: string;
  healerModel: string;

  // Limits
  maxExplorerCalls: number;       // Default: 60
  maxHealAttempts: number;        // Default: 2
}
```

## CLI

```
Usage: qa-agent [options]

Options:
  --url <url>           dApp URL to test (required)
  --seed <phrase>       Wallet seed phrase (or SEED_PHRASE env)
  --api-key <key>       OpenRouter API key (or OPENROUTER_API_KEY env)
  --output <dir>        Output directory (default: ./output/<dapp-name>)
  --headless            Run browser headlessly
  --model <model>       Default model for all phases
  --skip-heal           Skip the healer phase
  --only <phase>        Run only a specific phase (context|explore|plan|generate|execute|heal)
  -h, --help            Show help
```

## Dependencies

```json
{
  "dependencies": {
    "openai": "^4.x",              // For OpenRouter client
    "@tenkeylabs/dappwright": "2.13.3",  // MetaMask browser bootstrap
    "playwright-core": "^1.58.0",   // Browser automation
    "@playwright/test": "^1.58.0",  // Test runner for generated specs
    "commander": "^12.x"            // CLI argument parsing
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@types/node": "^20.x",
    "vitest": "^2.x"               // For mock tests
  }
}
```

## What Gets Reused from Existing Code

| File | Source | Adaptation |
|---|---|---|
| `llm/openrouter.ts` | `executor/agent/openrouter-client.ts` | Copy as-is |
| `llm/cost-tracker.ts` | `executor/agent/cost-tracker.ts` | Add Claude Sonnet pricing |
| `browser/tools.ts` | `executor/agent/tools/browser-tools.ts` | Extract tool functions, remove AgentContext coupling |
| `browser/wallet.ts` | `executor/agent/tools/wallet-tools.ts` + `dappwright-test/fixtures/wallet.fixture.ts` | Merge race-safe helpers from fixture |
| `browser/launcher.ts` | `dappwright-test/fixtures/wallet.fixture.ts` | Extract bootstrap logic |

## Testing Strategy

All tests run with mock LLM (no OpenRouter credits):

1. **tools.test.ts** — Browser + wallet tools work with a real browser (launches dappwright, navigates to a test page, clicks elements)
2. **explorer.test.ts** — Explorer agent loop works with mock LLM that returns scripted tool calls
3. **planner.test.ts** — Planner generates valid test plan JSON from sample exploration data
4. **generator.test.ts** — Generator outputs valid .spec.ts files with correct imports
5. **pipeline.test.ts** — Full pipeline runs end-to-end with mocks, produces all output files

## Estimated Cost Per dApp (OpenRouter)

| Phase | Model | Calls | Input tokens | Output tokens | Cost |
|---|---|---|---|---|---|
| Context | none | 0 | 0 | 0 | $0.00 |
| Explorer | claude-sonnet-4 | ~40 | ~120K | ~20K | ~$0.66 |
| Planner | claude-sonnet-4 | 1-2 | ~50K | ~10K | ~$0.30 |
| Generator | claude-sonnet-4 | ~6 | ~60K | ~30K | ~$0.63 |
| Execute | none | 0 | 0 | 0 | $0.00 |
| Healer | claude-sonnet-4 | ~5 | ~15K | ~8K | ~$0.17 |
| **Total** | | **~55** | **~245K** | **~68K** | **~$1.76** |

Sonnet 4 pricing: $3/M input, $15/M output on OpenRouter.

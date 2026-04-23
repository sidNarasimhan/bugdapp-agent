import type { ContextData } from '../types.js';
import type { PageScrapedData, InteractionRecord } from '../phases/context.js';
import type { ExplorerBrief } from '../phases/gap-analysis.js';

export function buildExplorerSystemPrompt(hasBrief?: boolean): string {
  if (hasBrief) {
    return `You are executing pre-planned user flows on a Web3 dApp.

## Context
The crawler has already discovered all elements on every page — clicked every button, toggled every switch, typed into every input, selected every dropdown option. Your job is to execute specific multi-step flows and report results.

## How to work
- Follow the flows IN ORDER. Don't wander off exploring.
- For each flow: navigate to the start page, execute the steps, verify the outcome, report what happened.
- Take a snapshot before and after each flow to record state changes.
- If a step fails, record the failure and move to the next flow.
- The wallet is ALREADY CONNECTED. Do NOT reconnect.

## Tools available
- Browser tools: browser_snapshot, browser_screenshot, browser_click, browser_type, browser_navigate, browser_press_key, browser_scroll, browser_select_option, browser_wait
- Wallet tools: wallet_approve_connection, wallet_sign, wallet_confirm_transaction, wallet_reject, wallet_switch_network
- Call exploration_complete with results after executing all flows.

## Rules
- Stick to the planned flows. Do not invent new exploration.
- If a click fails, move on IMMEDIATELY.
- After each interaction, take a snapshot to record the state change.
- Call exploration_complete with detailed findings including any bugs or unexpected behaviors found during flow execution.`;
  }

  return `You are an expert QA engineer exploring a Web3 dApp to discover how interactions work.

## Context
The dApp has already been fully crawled AND every element has been automatically clicked/toggled/typed into. You have the complete interaction results below — what each click did, what DOM changes occurred, what elements appeared/disappeared.

Your job is to use this pre-existing interaction data to build a comprehensive understanding of the dApp's behavior, then VERIFY key interactions that need deeper investigation (edge cases, multi-step flows, error states).

## What the crawl already did
- Clicked every button, toggle, switch on every page
- Typed test values into every input field
- Selected every dropdown option
- Clicked every tab
- Dragged sliders
- Scrolled to bottom for lazy-loaded content
- Took before/after screenshots for every interaction
- Recorded DOM diffs (what elements appeared/disappeared)

## Your job: DEEP VERIFICATION
You are a web3 QA engineer. Focus on things the automated crawl CANNOT do. Apply each category below to THIS specific dApp — whatever its domain (swap, perps, lending, staking, yield vault, bridge, CDP, NFT marketplace, prediction market, launchpad, etc.).

1. **Multi-step flows**: pick the primary user action for this dApp's domain, configure its inputs, and observe downstream computed fields. Examples by domain:
   - swap/DEX: choose token-in + token-out + amount → observe quote, slippage, price impact
   - perps: choose market + direction + collateral + leverage → observe position size, liquidation price, fees
   - lending: choose asset + action (supply/borrow/repay/withdraw) + amount → observe health factor, APY
   - staking/vault: choose pool + amount → observe projected rewards / APR
   - bridge: choose source + destination + amount → observe fees, arrival time
2. **Error states**: enter invalid, zero, or out-of-range inputs; values above balance; values below minimum; exceeding configured limits — verify the dApp blocks or warns appropriately.
3. **Conditional UI**: toggles, tabs, order-type switches, advanced-settings expanders that reveal new fields or change the form's shape.
4. **Cross-page state**: actions on one page visible on another (e.g., submit on main action page → verify row appears in portfolio / history).
5. **Wallet interactions**: behavior on insufficient funds, wrong network, needs-approval, permit-signing, rejected tx.
6. **Edge cases from docs**: any constraint the docs mention — minimum amounts, maximum leverage/ratios, restricted pairs, market hours, role-gating — needs verification.

## Rules
- **Budget: 50 tool calls.** Spend them on DEEP VERIFICATION, not re-clicking things the crawl already tested.
- The wallet is ALREADY CONNECTED. Do NOT reconnect.
- Use the interaction results below to understand what each element does BEFORE clicking it.
- If a click fails, move on IMMEDIATELY.
- After each interaction, take a snapshot to record the state change.
- You MUST visit ALL pages listed in navigationLinks — not just the primary one.
- Call exploration_complete with detailed findings including any bugs or unexpected behaviors.`;
}

export function buildExplorerUserPrompt(
  contextData: ContextData,
  dappUrl: string,
  navLinks?: { text: string; href: string }[],
  crawlSummary?: string,
  interactionSummary?: string,
): string {
  let prompt = `You are on this dApp with wallet already connected.

**URL:** ${dappUrl}
**Chain:** ${contextData.chain || 'Unknown'}
`;

  if (crawlSummary) {
    prompt += `
## CRAWL DATA (pages, elements, API endpoints)
${crawlSummary}
`;
  }

  if (interactionSummary) {
    prompt += `
## INTERACTION RESULTS (what every click/toggle/type DID)
The crawl already clicked every element. Here's what happened:
${interactionSummary}
`;
  }

  if (contextData.docsContent) {
    // Budget-aware docs inclusion:
    // - Sonnet has 200K tokens, we want to leave ~140K for tool call conversation
    // - Initial prompt budget: ~60K tokens = ~240K chars
    // - Crawl summary + interaction summary + system prompt: ~20K chars
    // - Remaining for docs: up to ~220K chars — but cap at 100K to be safe
    const currentPromptSize = prompt.length + (interactionSummary?.length || 0);
    const docsLimit = Math.max(25000, Math.min(100000, 240000 - currentPromptSize));

    if (contextData.docsContent.length <= docsLimit) {
      prompt += `
## DOCS (from official documentation — FULL)
${contextData.docsContent}
`;
    } else {
      prompt += `
## DOCS (from official documentation — ${Math.round(docsLimit/1000)}K of ${Math.round(contextData.docsContent.length/1000)}K chars, prioritized by relevance)
${contextData.docsContent.substring(0, docsLimit)}
... [${contextData.docsContent.length - docsLimit} chars truncated — full docs stored on disk]
`;
    }
  }

  // Build an adaptive task list from the nav links + crawl summary — no
  // hardcoded "/trade" or "/portfolio" assumptions. The LLM figures out what
  // this dApp actually offers from the pages it saw.
  const navList = (navLinks && navLinks.length > 0)
    ? navLinks.map(l => `  - ${l.text} (${l.href})`).join('\n')
    : '  (no nav links captured — use pages from the crawl summary above)';

  prompt += `
## YOUR TASK
You have complete crawl data + interaction results + docs above. The crawl already clicked every element — you know what each one does.

Now do DEEP VERIFICATION as a web3 QA engineer. This dApp's domain is whatever the crawl + docs show it to be — swap, perps, lending, staking, yield, bridge, CDP, NFT marketplace, prediction market, launchpad, etc. Figure it out, then test what matters for THAT domain.

## PAGES TO COVER (from crawl)
${navList}

## CHECKLIST
1. **Identify the primary user action** — from the forms, CTAs, and docs, what's the core thing a user does here? (e.g., swap tokens, open a position, supply an asset, stake, bridge, mint). Verify this end-to-end with realistic inputs.
2. **Test the form end-to-end** — pick an entity (asset/market/pool/pair/collection), fill the inputs with realistic values, verify the computed/derived fields update correctly (quotes, fees, health factor, projected rewards, whatever this dApp shows).
3. **Test conditional/advanced UI** — any toggles, tabs, order types, advanced settings, or expanders that change the form's shape. Verify new fields appear / old fields disappear as expected.
4. **Test edge cases** — enter 0, empty, above balance, above configured maximum, below configured minimum. Verify the dApp warns or blocks.
5. **Cover every page in the nav list above** — verify each loads, identify what it's for, test any meaningful interaction.
6. **Cross-page state** — any state change on one page that should be reflected elsewhere (positions, history, balances, orders).
7. **Look for bugs** — broken UI, wrong calculations, elements that don't respond, validation that fires on correct input, stuck loading states.

Call exploration_complete with your findings ONLY after covering all pages and flows.

BEGIN — take a snapshot now.`;

  return prompt;
}

export function buildExplorerBriefPrompt(
  contextData: ContextData,
  dappUrl: string,
  brief: ExplorerBrief,
): string {
  let prompt = `You are on this dApp with wallet already connected.

**URL:** ${dappUrl}
**Chain:** ${contextData.chain || 'Unknown'}
**Budget:** ~${brief.estimatedBudget} tool calls

## PAGE SUMMARIES (what the crawler already found)
`;

  for (const page of brief.pageSummaries) {
    prompt += `\n### ${page.path} (${page.elementsCovered}/${page.elementsTotal} elements covered)`;
    if (page.discoveredBehaviors.length > 0) {
      prompt += `\n  Behaviors: ${page.discoveredBehaviors.join('; ')}`;
    }
    if (page.meaningfulElements.length > 0) {
      prompt += `\n  Key elements: ${page.meaningfulElements.join(', ')}`;
    }
  }

  prompt += `

## TARGETED FLOWS TO EXECUTE

The crawler has already clicked every element on every page. Below are the specific multi-step flows that need verification.

For each flow:
1. Navigate to the start page
2. Take a snapshot
3. Execute each step
4. Take a snapshot after each step
5. Report what happened vs what was expected
`;

  for (let i = 0; i < brief.targetedFlows.length; i++) {
    const flow = brief.targetedFlows[i];
    prompt += `
### Flow ${i + 1}: ${flow.name} (Priority ${flow.priority})
Page: ${flow.startPage}
Reason: ${flow.reason}
Steps:`;
    for (let s = 0; s < flow.steps.length; s++) {
      prompt += `\n  ${s + 1}. ${flow.steps[s]}`;
    }
    prompt += `\nExpected: ${flow.expectedOutcome}
`;
  }

  prompt += `
## INSTRUCTIONS
- You have browser tools (snapshot, screenshot, click, type, navigate, press_key, scroll, select_option, wait) and wallet tools (approve_connection, sign, confirm_transaction, reject, switch_network).
- Execute the flows above IN ORDER. For each one, navigate to the start page, take a snapshot, execute the steps, and verify the outcome.
- After completing all flows, call exploration_complete with your detailed findings.
- Budget is ~${brief.estimatedBudget} tool calls. Be efficient — don't waste calls on unnecessary snapshots.

BEGIN — take a snapshot of the current page, then start with Flow 1.`;

  return prompt;
}

/**
 * Build a compact summary of crawled data for the explorer.
 * Auto-generates an interaction checklist from discovered elements.
 * No dApp-specific hardcoding — everything derived from crawl output.
 */
export function buildCrawlSummary(
  scrapedData: Record<string, PageScrapedData>,
  networkAssets: { groups: Record<string, string[]>; totalPairs: number },
  networkConfigs?: { groupInfo?: Record<string, any>; pairCount?: number },
  bundleInfo?: { testIds: number; routes: string[]; errorCount: number },
  apiEndpoints?: { path: string; bodyPreview: string }[],
  rawApiData?: Record<string, any>,
  bundleAnalysis?: any,
): string {
  const lines: string[] = [];

  // Pages — full context including visible text
  lines.push('### Pages');
  for (const [path, data] of Object.entries(scrapedData)) {
    lines.push(`\n**${path}** (${data.elements.length} elements)`);

    if (data.visibleText) {
      lines.push(`  Visible text: ${data.visibleText.replace(/\s+/g, ' ').trim().slice(0, 800)}`);
    }

    const byRole: Record<string, string[]> = {};
    for (const el of data.elements) {
      if (!byRole[el.role]) byRole[el.role] = [];
      const label = el.name || '(unnamed)';
      if (!byRole[el.role].includes(label)) byRole[el.role].push(label);
    }
    for (const [role, names] of Object.entries(byRole)) {
      lines.push(`  ${role}s: ${names.join(', ')}`);
    }

    if (Object.keys(data.dropdownContents).length > 0) {
      for (const [trigger, items] of Object.entries(data.dropdownContents)) {
        lines.push(`  Dropdown "${trigger}": ${items.join(', ')}`);
      }
    }
  }

  // Trading pairs from API
  if (networkAssets.totalPairs > 0) {
    lines.push('\n### Trading Pairs (from API)');
    lines.push(`Total: ${networkAssets.totalPairs} pairs`);
    for (const [group, pairs] of Object.entries(networkAssets.groups)) {
      lines.push(`  ${group}: ${pairs.join(', ')}`);
    }
  }

  // Market configs from API
  if (networkConfigs?.groupInfo) {
    lines.push('\n### Market Group Configs (from API)');
    for (const [, info] of Object.entries(networkConfigs.groupInfo)) {
      const g = info as any;
      lines.push(`  ${g.name}: maxOI=${g.groupMaxOI}, maxInterestP=${g.maxOpenInterestP}%`);
    }
  }

  // Full API digest — extract meaningful data from raw responses, not just 200-char previews
  if (rawApiData) {
    lines.push('\n### API Data (full digest)');
    lines.push(buildApiDigest(rawApiData));
  } else if (apiEndpoints && apiEndpoints.length > 0) {
    // Fallback to previews if raw data not available
    lines.push('\n### API Responses Captured');
    for (const ep of apiEndpoints) {
      lines.push(`  ${ep.path}: ${ep.bodyPreview}`);
    }
  }

  // Bundle analysis digest — test IDs, routes, and key error messages
  if (bundleAnalysis) {
    lines.push('\n### Code Analysis (from JS bundles)');
    lines.push(buildBundleDigest(bundleAnalysis));
  } else if (bundleInfo) {
    lines.push(`\n### Code Analysis`);
    lines.push(`TestIDs: ${bundleInfo.testIds}`);
    lines.push(`Routes: ${bundleInfo.routes.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Extract meaningful data from raw API responses.
 * Skips noise (wallets, analytics, auth), extracts trading configs, user state, market data.
 */
function buildApiDigest(rawApiData: Record<string, any>): string {
  const lines: string[] = [];
  const skip = /\/(wallets|flags|logs|sanctions|ip_address|version|initialize|v2\/CGag)/;

  for (const [path, body] of Object.entries(rawApiData)) {
    if (skip.test(path)) continue;
    if (!body || typeof body !== 'object') continue;

    const bodyStr = JSON.stringify(body);
    const size = bodyStr.length;

    // Small responses (< 2KB): include full
    if (size < 2000) {
      lines.push(`\n  **${path}** (${(size/1024).toFixed(1)}KB):`);
      lines.push(`  ${bodyStr}`);
      continue;
    }

    // Medium responses (2-20KB): include structure + key values
    if (size < 20000) {
      lines.push(`\n  **${path}** (${(size/1024).toFixed(1)}KB):`);
      lines.push(`  ${summarizeObject(body, 1000)}`);
      continue;
    }

    // Large responses (20KB+): extract structure only
    lines.push(`\n  **${path}** (${(size/1024).toFixed(1)}KB):`);

    // Special handling for socket data (contains all pair/group configs)
    if (body?.data?.groupInfo || body?.data?.pairInfos) {
      const d = body.data;
      if (d.groupInfo) {
        lines.push(`  Groups: ${Object.values(d.groupInfo).map((g: any) => `${g.name}(maxOI=${g.groupMaxOI}, OI=${g.groupOI})`).join(', ')}`);
      }
      if (d.pairInfos) {
        const pairs = Object.values(d.pairInfos) as any[];
        const sample = pairs.filter((p: any) => p.from).slice(0, 5);
        lines.push(`  Pairs: ${pairs.length} total. Sample: ${sample.map((p: any) => JSON.stringify({from: p.from, to: p.to, groupIndex: p.groupIndex, feeIndex: p.feeIndex, minLeverage: p.pairMinLeverage, maxLeverage: p.pairMaxLeverage})).join(', ')}`);
      }
      if (d.feeInfo) {
        lines.push(`  Fees: ${JSON.stringify(d.feeInfo).slice(0, 500)}`);
      }
      if (d.borrowInfo) {
        lines.push(`  Borrow: ${JSON.stringify(d.borrowInfo).slice(0, 300)}`);
      }
      continue;
    }

    // Special handling for price feeds
    if (Array.isArray(body) && body[0]?.price) {
      lines.push(`  ${body.length} price feeds. Sample: ${JSON.stringify(body[0])}`);
      continue;
    }

    // Special handling for trade history
    if (body?.history && Array.isArray(body.history)) {
      lines.push(`  ${body.history.length} entries. Sample: ${JSON.stringify(body.history[0]).slice(0, 300)}`);
      continue;
    }

    // Generic: show keys and first-level structure
    lines.push(`  ${summarizeObject(body, 500)}`);
  }

  return lines.join('\n');
}

function summarizeObject(obj: any, maxLen: number): string {
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const sample = JSON.stringify(obj[0]).slice(0, maxLen / 2);
    return `[${obj.length} items] first: ${sample}`;
  }
  if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj).slice(0, maxLen);

  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const valStr = Array.isArray(v)
      ? `[${v.length} items]`
      : typeof v === 'object' && v !== null
        ? `{${Object.keys(v).slice(0, 5).join(', ')}${Object.keys(v).length > 5 ? '...' : ''}}`
        : JSON.stringify(v);
    parts.push(`${k}: ${valStr.slice(0, 100)}`);
    if (parts.join(', ').length > maxLen) break;
  }
  return `{${parts.join(', ')}}`;
}

/**
 * Extract useful info from bundle analysis — test IDs, routes, and important error messages.
 */
function buildBundleDigest(bundle: any): string {
  const lines: string[] = [];

  if (bundle.testIds?.length > 0) {
    lines.push(`  Test IDs (${bundle.testIds.length}): ${bundle.testIds.join(', ')}`);
  }

  if (bundle.routes?.length > 0) {
    lines.push(`  Routes (${bundle.routes.length}): ${bundle.routes.join(', ')}`);
  }

  if (bundle.errorMessages?.length > 0) {
    // Deduplicate and keep unique, meaningful error messages
    const unique = [...new Set(bundle.errorMessages as string[])];
    // Filter for user-facing errors (not stack traces or generic)
    const userFacing = unique.filter((e: string) =>
      e.length > 10 && e.length < 200 &&
      !/stack|trace|debug|webpack|chunk|module|undefined/i.test(e)
    );
    const topErrors = userFacing.slice(0, 50);
    lines.push(`  Error messages (${unique.length} unique, showing ${topErrors.length} user-facing):`);
    for (const err of topErrors) {
      lines.push(`    - "${err}"`);
    }
  }

  return lines.join('\n');
}

/**
 * Build a condensed interaction summary from the exhaustive crawl.
 * Strips noisy DOM fingerprints (price changes), keeps meaningful state changes.
 */
export function buildInteractionSummary(interactions: InteractionRecord[]): string {
  if (!interactions || interactions.length === 0) return '(no interactions recorded)';

  const lines: string[] = [];
  const byPage: Record<string, InteractionRecord[]> = {};
  for (const r of interactions) {
    if (!byPage[r.page]) byPage[r.page] = [];
    byPage[r.page].push(r);
  }

  for (const [page, records] of Object.entries(byPage)) {
    lines.push(`\n**${page}** (${records.length} interactions)`);

    for (const r of records) {
      const totalChanges = r.domChanges.appeared.length + r.domChanges.disappeared.length;

      // Filter out noisy DOM changes (price tickers, timestamps)
      const meaningfulAppeared = r.domChanges.appeared
        .filter(s => !/^\w+:[\d,.$%]+$/.test(s)) // skip pure numeric entries
        .filter(s => !/Fast$/.test(s)) // skip gas speed indicators
        .slice(0, 5);

      const meaningfulDisappeared = r.domChanges.disappeared
        .filter(s => !/^\w+:[\d,.$%]+$/.test(s))
        .filter(s => !/Fast$/.test(s))
        .slice(0, 3);

      // Build a human-readable line
      let line = `  ${r.action} "${r.elementName}"`;
      if (r.value) line += ` val="${r.value}"`;
      line += ` → +${r.domChanges.appeared.length}/-${r.domChanges.disappeared.length}`;

      if (meaningfulAppeared.length > 0) {
        const labels = meaningfulAppeared.map(s => {
          const parts = s.split(':');
          return parts.length > 1 ? parts.slice(1).join(':').slice(0, 30) : s.slice(0, 30);
        });
        line += ` | new: ${labels.join(', ')}`;
      }

      if (!r.success) line += ` [FAILED: ${r.error?.slice(0, 50)}]`;

      lines.push(line);
    }
  }

  lines.push(`\n**Summary**: ${interactions.length} interactions, ${interactions.filter(r => r.success).length} successful, ${interactions.filter(r => !r.success).length} failed`);

  return lines.join('\n');
}

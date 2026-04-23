import type {
  BrowserCtx, ContextData, ExplorationResult, ToolCallResult, ToolDefinition, StateEdge,
} from '../types.js';
import { browserToolDefs, executeBrowserTool } from '../browser/tools.js';
import { walletToolDefs, executeWalletTool } from '../browser/wallet.js';
import { CostTracker } from '../llm/cost-tracker.js';
import {
  createOpenRouterClient,
  type MessageParam, type ContentBlockToolUse, type ContentBlockText,
  type ToolResultBlockParam, type ToolParam,
} from '../llm/openrouter.js';
import { buildExplorerSystemPrompt, buildExplorerUserPrompt, buildExplorerBriefPrompt } from '../prompts/explorer.js';
import { StateGraph } from '../graph/state-graph.js';
import { startNetworkCapture } from '../browser/network.js';
import type { ExplorerBrief } from './gap-analysis.js';

const explorationCompleteDef: ToolDefinition = {
  name: 'exploration_complete',
  description: 'Call when you have finished exploring all pages, dropdowns, modals, and states. Provide a comprehensive JSON summary.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Brief text summary of what was found' },
      modules: {
        type: 'array',
        description: 'Array of dApp modules discovered',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Module name — whatever the dApp calls this section (e.g. Trade, Swap, Supply, Stake, Bridge, Portfolio, Earn)' },
            url: { type: 'string' },
            description: { type: 'string', description: 'What this module does in the dApp' },
            states: { type: 'array', items: { type: 'string' }, description: 'Different states / modes / variations the module exposes — any toggles, tabs, directions, order types, fee modes, feature flags, etc. Examples vary by dApp class (swap vs perps vs lending vs staking).' },
            dropdownOptions: { type: 'object', description: 'Map of dropdown name -> list of options discovered' },
            forms: { type: 'array', items: { type: 'string' }, description: 'Form inputs and their constraints' },
            modals: { type: 'array', items: { type: 'string' }, description: 'Modals that can be opened' },
            walletRequired: { type: 'boolean' },
            keyElements: { type: 'array', items: { type: 'string' }, description: 'Key interactive elements' },
          },
        },
      },
      connectFlow: { type: 'array', items: { type: 'string' }, description: 'Steps to connect wallet' },
      navigationLinks: { type: 'array', items: { type: 'string' }, description: 'Top-level nav items' },
      entities: { type: 'array', items: { type: 'string' }, description: 'ALL domain entities discovered — these are the things a user acts ON. For a DEX / perps: tradeable symbols (ETH-USD, BTC-USD). For a lending protocol: markets / assets (USDC, WETH, DAI). For a staking protocol: staking pools / validators. For an NFT marketplace: collections. List EVERY entity you saw in dropdowns or item lists.' },
      modes: { type: 'array', items: { type: 'string' }, description: 'All module modes / variations discovered — directions, order types, fee modes, feature toggles, etc. Examples vary by dApp class: perps (Long/Short, Market/Limit, TP/SL on/off), swap (exact-in/exact-out), lending (Supply/Borrow/Repay/Withdraw), staking (Stake/Unstake/Claim).' },
    },
    required: ['summary', 'modules', 'connectFlow', 'navigationLinks', 'entities'],
  },
};

const ALL_TOOLS: ToolDefinition[] = [...browserToolDefs, ...walletToolDefs, explorationCompleteDef];
const BROWSER_TOOLS = new Set(browserToolDefs.map(t => t.name));
const WALLET_TOOLS = new Set(walletToolDefs.map(t => t.name));

export async function runExplorer(
  ctx: BrowserCtx,
  contextData: ContextData,
  config: { model: string; apiKey: string; maxCalls: number; navLinks?: { text: string; href: string }[]; crawlSummary?: string; interactionSummary?: string },
  explorerBrief?: ExplorerBrief,
): Promise<{ exploration: ExplorationResult; costTracker: CostTracker }> {
  const client = createOpenRouterClient(config.apiKey);
  const costTracker = new CostTracker(config.model);
  let apiCalls = 0;
  let consecutiveEndTurns = 0;

  const hasBrief = !!explorerBrief;
  const systemPrompt = buildExplorerSystemPrompt(hasBrief);
  const userPrompt = hasBrief
    ? buildExplorerBriefPrompt(contextData, contextData.url, explorerBrief!)
    : buildExplorerUserPrompt(contextData, contextData.url, config.navLinks, config.crawlSummary, config.interactionSummary);

  const tools = ALL_TOOLS.map(t => ({
    name: t.name, description: t.description, input_schema: t.input_schema,
  }));

  const messages: MessageParam[] = [{ role: 'user', content: userPrompt }];

  // Start network capture before navigating — passively collects all API responses
  const networkCapture = startNetworkCapture(ctx.page);

  // Navigate to the dApp URL
  const startUrl = contextData.url;
  console.log(`[Explorer] Navigating to ${startUrl}...`);
  await ctx.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await ctx.page.waitForTimeout(5000);

  // Tell the LLM the page is loaded — wallet connection instructions are in the system prompt
  messages[0] = {
    role: 'user',
    content: userPrompt + `\n\n## CURRENT STATE\nI navigated to ${startUrl}. The page is loaded. Begin with Step 1 — take a snapshot and connect the wallet.`,
  };

  const pageSnapshots: Map<string, { snapshot: string; screenshotPath?: string }> = new Map();
  let explorationResult: ExplorationResult | null = null;
  let rawModules: any[] = [];
  let rawTradingAssets: string[] = [];

  // ── State Graph tracking ──
  const graph = new StateGraph();
  let currentStateHash: string | null = null;
  let pendingAction: StateEdge['action'] | null = null;
  let walletConnected = false;

  /** Capture the current page state as a graph node, and create an edge from the previous state if an action was pending. */
  async function captureState(snapshotText: string, screenshotPath?: string): Promise<string> {
    const url = ctx.page.url();
    const title = await ctx.page.title();

    // Parse elements from snapshot text
    const elements: { ref: string; role: string; name: string; tag?: string }[] = [];
    for (const [ref, info] of ctx.snapshotRefs.entries()) {
      elements.push({ ref, role: info.role, name: info.name, tag: info.tag });
    }

    // Detect active modal from snapshot (look for dialog/modal roles)
    let activeModal: string | null = null;
    const modalMatch = snapshotText.match(/\[dialog\]\s*"([^"]+)"/);
    if (modalMatch) activeModal = modalMatch[1];

    // Extract form state from snapshot (inputs with values)
    const formState: Record<string, string> = {};
    const valueMatches = snapshotText.matchAll(/\[ref=(e\d+)\]\s*\[(?:textbox|input|spinbutton)\]\s*"([^"]*)"\s*(?:.*?value="([^"]*)")?/g);
    for (const m of valueMatches) {
      if (m[3]) formState[m[2] || m[1]] = m[3];
    }

    const node = graph.addNode({
      url,
      pageTitle: title,
      elements,
      walletConnected,
      activeModal,
      formState,
      screenshotPath,
      snapshotText,
    });

    // Create edge from previous state if we have a pending action
    if (pendingAction && currentStateHash && currentStateHash !== node.hash) {
      const sideEffects: string[] = [];
      if (!walletConnected && node.walletConnected) sideEffects.push('wallet connected');
      if (activeModal) sideEffects.push(`modal opened: ${activeModal}`);
      graph.addEdge(currentStateHash, node.hash, pendingAction, true, sideEffects);
    } else if (pendingAction && currentStateHash && currentStateHash === node.hash) {
      // Action didn't change state — still record it as a self-loop
      graph.addEdge(currentStateHash, node.hash, pendingAction, true, ['no state change']);
    }

    currentStateHash = node.hash;
    pendingAction = null;
    return node.hash;
  }

  /** Map a tool call to a graph action type */
  function toolToAction(toolName: string, input: Record<string, unknown>): StateEdge['action'] | null {
    const ref = input.ref as string | undefined;
    const refInfo = ref ? ctx.snapshotRefs.get(ref) : undefined;
    const target = refInfo ? `${refInfo.role}:"${refInfo.name}"` : ref;

    switch (toolName) {
      case 'browser_click': return { type: 'click', target: target || input.description as string };
      case 'browser_type': return { type: 'type', target, value: input.text as string };
      case 'browser_navigate': return { type: 'navigate', target: input.url as string };
      case 'browser_press_key': return { type: 'press_key', value: input.key as string };
      case 'browser_scroll': return { type: 'scroll', value: input.direction as string };
      case 'wallet_approve_connection': return { type: 'wallet_approve' };
      case 'wallet_sign': return { type: 'wallet_sign' };
      case 'wallet_confirm_transaction': return { type: 'wallet_confirm' };
      case 'wallet_reject': return { type: 'wallet_reject' };
      case 'wallet_switch_network': return { type: 'wallet_switch_network', value: input.networkName as string };
      default: return null;
    }
  }

  console.log(`[Explorer] Starting deep exploration with ${config.model}, max ${config.maxCalls} calls`);

  while (apiCalls < config.maxCalls && !explorationResult) {
    try {
      const response = await client.messages.create({
        model: config.model,
        max_tokens: 8192,
        system: systemPrompt,
        tools: tools as ToolParam[],
        messages: truncateMessages(messages, 80000), // Keep context manageable
      });

      apiCalls++;
      if (response.usage) costTracker.recordUsage(response.usage);

      // Budget warning — force completion before running out
      const remaining = config.maxCalls - apiCalls;
      if (remaining === 10) {
        // Inject a nudge into the next user message
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: `⚠️ BUDGET WARNING: You have only 10 tool calls remaining. You MUST call exploration_complete within the next few calls with EVERYTHING you've discovered so far. Do NOT spend remaining calls on more browsing — summarize your findings NOW and call exploration_complete.`,
        });

        // Process any tool calls from this response first
        const urgentToolBlocks = response.content.filter(
          (b): b is ContentBlockToolUse => b.type === 'tool_use'
        );
        if (urgentToolBlocks.length > 0) {
          const urgentResults: ToolResultBlockParam[] = [];
          for (const tb of urgentToolBlocks) {
            const input = tb.input as Record<string, unknown>;
            let result: ToolCallResult;
            if (tb.name === 'exploration_complete') {
              rawModules = (input.modules as any[]) || [];
              // Accept both the new "entities" field (domain-agnostic) and the
              // legacy "tradingAssets" field (TradeFi-only) so older cached
              // explorer outputs still load.
              rawTradingAssets = (input.entities as string[]) || (input.tradingAssets as string[]) || [];
              result = { success: true, output: 'Exploration complete.' };
              console.log(`[Explorer] Complete (budget warning): ${input.summary}`);
              // Mark as done — the main loop will build the result
            } else if (BROWSER_TOOLS.has(tb.name)) {
              result = await executeBrowserTool(tb.name, input, ctx);
            } else if (WALLET_TOOLS.has(tb.name)) {
              result = await executeWalletTool(tb.name, input, ctx);
            } else {
              result = { success: false, output: `Unknown tool: ${tb.name}` };
            }
            urgentResults.push({ type: 'tool_result', tool_use_id: tb.id, content: result.output, is_error: !result.success });
          }
          // Remove the assistant message we added, replace with one that includes tool results
          messages.pop(); // remove budget warning
          messages.pop(); // remove assistant
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: urgentResults });
          messages.push({ role: 'user', content: `⚠️ BUDGET WARNING: ${remaining - urgentToolBlocks.length} calls left. Call exploration_complete NOW.` });
        }
        continue;
      }

      // Handle end_turn
      if (response.stop_reason === 'end_turn') {
        consecutiveEndTurns++;
        const textContent = response.content
          .filter((b): b is ContentBlockText => b.type === 'text')
          .map(b => b.text).join('\n');
        if (textContent) console.log(`[Explorer] LLM: ${textContent.slice(0, 200)}`);

        if (consecutiveEndTurns >= 3) {
          console.log('[Explorer] 3 consecutive end_turns — forcing exploration_complete');
          break;
        }

        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: 'Continue exploring. You MUST call exploration_complete when done. If you\'ve visited all pages, call it now with your findings.',
        });
        continue;
      }

      consecutiveEndTurns = 0;

      if (response.stop_reason === 'max_tokens') {
        console.log('[Explorer] Hit max_tokens — nudging to complete');
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: 'You hit the token limit. Call exploration_complete NOW with everything you\'ve discovered so far.',
        });
        continue;
      }

      if (response.stop_reason !== 'tool_use') {
        console.log(`[Explorer] Unexpected stop: ${response.stop_reason}`);
        break;
      }

      // Process tool calls
      const toolBlocks = response.content.filter(
        (b): b is ContentBlockToolUse => b.type === 'tool_use'
      );

      messages.push({ role: 'assistant', content: response.content });
      const toolResults: ToolResultBlockParam[] = [];

      for (const toolBlock of toolBlocks) {
        const toolInput = toolBlock.input as Record<string, unknown>;
        let result: ToolCallResult;

        if (toolBlock.name === 'exploration_complete') {
          rawModules = (toolInput.modules as any[]) || [];
          // Accept both new `entities` (domain-agnostic) and legacy `tradingAssets` (TradeFi-only).
          rawTradingAssets = (toolInput.entities as string[]) || (toolInput.tradingAssets as string[]) || [];

          const pages = rawModules.map((m: any) => ({
            url: m.url || '',
            name: m.name || '',
            snapshot: pageSnapshots.get(m.url)?.snapshot || pageSnapshots.get(resolveUrl(contextData.url, m.url))?.snapshot || '',
            screenshotPath: pageSnapshots.get(m.url)?.screenshotPath,
            interactiveElements: (m.keyElements || []).map((e: string) => ({ role: 'element', name: e })),
            walletRequired: m.walletRequired || false,
            web3Elements: [],
          }));

          // Get wallet state
          let connectedState = null;
          try {
            const addr = await ctx.page.evaluate(() => (window as any).ethereum?.selectedAddress || null);
            if (addr) {
              const chainId = await ctx.page.evaluate(() =>
                (window as any).ethereum?.request?.({ method: 'eth_chainId' })
              ).catch(() => null);
              connectedState = { address: addr, network: contextData.chain || 'Unknown', chainId: chainId || 'unknown' };
            }
          } catch {}

          explorationResult = {
            pages,
            connectedState,
            connectFlow: (toolInput.connectFlow as string[]) || [],
            navigationLinks: (toolInput.navigationLinks as string[]) || [],
            modules: rawModules,
            tradingAssets: rawTradingAssets,
            graph: graph.serialize(),
          };

          result = { success: true, output: 'Exploration complete.' };
          console.log(`[Explorer] Complete: ${toolInput.summary}`);
        } else if (BROWSER_TOOLS.has(toolBlock.name)) {
          // Track pending action before executing (for graph edges)
          const action = toolToAction(toolBlock.name, toolInput);
          if (action) pendingAction = action;

          result = await executeBrowserTool(toolBlock.name, toolInput, ctx);

          if (toolBlock.name === 'browser_snapshot' && result.success) {
            const url = ctx.page.url();
            pageSnapshots.set(url, { snapshot: result.output, ...pageSnapshots.get(url) });
            // Capture state for graph
            await captureState(result.output);
          }
          if (toolBlock.name === 'browser_screenshot' && result.success) {
            const url = ctx.page.url();
            const existing = pageSnapshots.get(url) || { snapshot: '' };
            pageSnapshots.set(url, { ...existing, screenshotPath: result.output });
          }

          // If action failed, record failed edge
          if (action && !result.success && currentStateHash) {
            graph.addEdge(currentStateHash, currentStateHash, action, false, [result.output.slice(0, 100)]);
            pendingAction = null;
          }
        } else if (WALLET_TOOLS.has(toolBlock.name)) {
          const action = toolToAction(toolBlock.name, toolInput);
          if (action) pendingAction = action;

          result = await executeWalletTool(toolBlock.name, toolInput, ctx);

          if (result.success && toolBlock.name === 'wallet_approve_connection') {
            walletConnected = true;
          }
          if (!result.success && action && currentStateHash) {
            graph.addEdge(currentStateHash, currentStateHash, action, false, [result.output.slice(0, 100)]);
            pendingAction = null;
          }
        } else {
          result = { success: false, output: `Unknown tool: ${toolBlock.name}` };
        }

        if (!result!) {
          result = { success: false, output: `Tool ${toolBlock.name} returned no result` };
        }
        const status = result.success ? 'OK' : 'FAIL';
        if (toolBlock.name !== 'browser_snapshot') {
          console.log(`[Explorer] ${toolBlock.name} → ${status}: ${(result.output || '').slice(0, 120)}`);
        } else {
          console.log(`[Explorer] browser_snapshot → ${(result.output || '').length} chars`);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: result.output,
          is_error: !result.success,
        });
      }

      messages.push({ role: 'user', content: toolResults });

    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[Explorer] Error: ${msg}`);
      if (msg.includes('rate_limit') || msg.includes('overloaded')) {
        console.log('[Explorer] Rate limited, waiting 5s...');
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      break;
    }
  }

  // Fallback if LLM didn't call exploration_complete
  if (!explorationResult) {
    console.warn('[Explorer] Building result from collected data...');
    explorationResult = {
      pages: [...pageSnapshots.entries()].map(([url, data]) => ({
        url, name: url.split('/').pop() || 'page', snapshot: data.snapshot,
        screenshotPath: data.screenshotPath, interactiveElements: [], walletRequired: false,
      })),
      connectedState: null, connectFlow: [], navigationLinks: [],
      modules: [], tradingAssets: [],
      graph: graph.serialize(),
    };
  }

  // Stop network capture and merge intercepted data
  const captured = networkCapture.stop();
  if (captured.assets.length > 0) {
    const existingAssets = new Set(explorationResult.tradingAssets || []);
    for (const a of captured.assets) existingAssets.add(a);
    explorationResult.tradingAssets = [...existingAssets].sort();
    console.log(`[Network] Intercepted ${captured.responses.length} API responses, found ${captured.assets.length} assets: ${captured.assets.join(', ')}`);
  }
  if (captured.markets.length > 0) {
    (explorationResult as any).interceptedMarkets = captured.markets;
    console.log(`[Network] Found ${captured.markets.length} market configs`);
  }
  if (Object.keys(captured.rawApiData).length > 0) {
    (explorationResult as any).apiData = captured.rawApiData;
  }

  const stats = graph.stats;
  console.log(`[Explorer] Done — ${apiCalls} API calls, ${explorationResult.pages.length} pages, ${stats.nodeCount} states, ${stats.edgeCount} transitions, ${costTracker.toString()}`);
  return { exploration: explorationResult, costTracker };
}

/**
 * Truncate old messages to keep context window manageable.
 * Keep first message (user prompt) and last N messages.
 */
function truncateMessages(messages: MessageParam[], maxChars: number): MessageParam[] {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += JSON.stringify(m.content).length;
  }

  if (totalChars <= maxChars) return messages;

  // Keep first 2 messages and last 10
  const first = messages.slice(0, 2);
  const last = messages.slice(-10);
  return [...first, { role: 'user' as const, content: '[Earlier exploration messages truncated for context management. Continue from where you left off.]' }, ...last];
}

function resolveUrl(base: string, path: string): string {
  try { return new URL(path, base).href; } catch { return path; }
}

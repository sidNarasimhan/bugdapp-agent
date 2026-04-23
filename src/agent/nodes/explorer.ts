import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { AgentStateType, KnowledgeGraph, KGFlow, KGFlowStep, KGEdgeCase, ComputedFlow } from '../state.js';
import { DAppGraph } from '../state.js';
import { createAllTools } from '../tools.js';
import type { BrowserCtx } from '../../types.js';

// Structured findings collected during exploration
interface ExplorerFindings {
  flows: KGFlow[];
  edgeCases: KGEdgeCase[];
  validationRules: { input: string; rule: string; behavior: string }[];
  uiBehaviors: { trigger: string; result: string }[];
}

function buildExplorerSystemPrompt(kg: KnowledgeGraph, crawlData: any, docsContent: string): string {
  const pageList = kg.pages.map(p => `- ${p.url} (${p.elementCount} elements)`).join('\n');
  const untestedFlows = kg.flows.filter(f => !f.tested);
  const flowList = untestedFlows.map(f =>
    `- [${f.category}] ${f.name} (${f.steps.length} steps, priority ${f.priority})`
  ).join('\n');

  // Build component summary per page (compact)
  const componentsByPage = new Map<string, string[]>();
  for (const comp of kg.components) {
    if (!comp.name || comp.disabled) continue;
    if (!componentsByPage.has(comp.pageId)) componentsByPage.set(comp.pageId, []);
    componentsByPage.get(comp.pageId)!.push(`  ${comp.role}: "${comp.name}"`);
  }
  const componentSummary = [...componentsByPage.entries()]
    .map(([pageId, comps]) => `${pageId}:\n${comps.slice(0, 15).join('\n')}`)
    .join('\n\n');

  // Interaction highlights
  const interactionHighlights = (crawlData?.interactions || [])
    .filter((ix: any) => ix.success && ix.domChanges?.appeared?.length > 0)
    .slice(0, 30)
    .map((ix: any) => `- Click "${ix.elementName}" (${ix.elementRole}) → ${ix.domChanges.appeared.length} new elements: ${ix.domChanges.appeared.slice(0, 3).join(', ')}`)
    .join('\n');

  // API data highlights
  const apiEndpoints = crawlData?.networkData?.rawApiData
    ? Object.keys(crawlData.networkData.rawApiData).filter(k => !/flags|initialize|wallets|logs|sanctions/.test(k)).slice(0, 15)
    : [];

  return `You are a senior Web3 QA engineer doing DEEP VERIFICATION of a dApp that has already been crawled.

## IMPORTANT: The wallet is ALREADY CONNECTED. The crawler already visited every page and clicked every button.
## Your job is NOT to repeat the crawl. Your job is to discover things the crawler MISSED:
- What happens when you SUBMIT forms (the crawler never submits)
- What ERROR MESSAGES appear for invalid inputs
- What VALIDATION the UI shows (min/max values, required fields)
- What MODALS appear during multi-step flows
- What STATE CHANGES happen after wallet interactions
- What LOADING STATES and CONFIRMATION screens look like

## YOUR MISSION
1. Start with browser_snapshot — wallet should be connected
2. Try filling the main form with real values and observe what happens
3. Try invalid inputs (0, negative, very large numbers) and capture error messages
4. Try submitting without required fields
5. Switch between different options (order types, assets) and note UI changes
6. Look for tooltips, help text, warnings that appear on interaction

## THE DAPP
${crawlData?.context?.title || 'Unknown dApp'}
${crawlData?.context?.description || ''}
Chain: ${crawlData?.context?.chain || 'Unknown'}
Features: ${(crawlData?.context?.features || []).join(', ')}

## PAGES DISCOVERED BY CRAWLER
${pageList}

## INTERACTIVE COMPONENTS BY PAGE
${componentSummary}

## WHAT THE CRAWLER FOUND WHEN CLICKING THINGS
${interactionHighlights || 'No interaction data available.'}

## API ENDPOINTS DETECTED
${apiEndpoints.map(e => `- ${e}`).join('\n') || 'None detected.'}

## DOCUMENTATION (summary)
${docsContent ? docsContent.slice(0, 5000) : 'No documentation available.'}

## KNOWN FLOWS (from crawler, NOT YET VERIFIED)
${flowList || 'No flows discovered yet.'}

## HOW TO EXPLORE (wallet is already connected)
1. Start by taking a browser_snapshot to see the current page state
2. Fill form inputs with values and try submitting — observe what happens
3. Try INVALID inputs: 0, -1, 999999, empty — capture error messages
4. Switch between dropdown options and note what changes in the UI
5. Try to trigger edge cases: submit without required fields, exceed limits
6. Navigate to other pages only if you've exhausted the current page's interactions

## CRITICAL RULES
- ALWAYS take a browser_snapshot before clicking anything — refs change between snapshots
- After EVERY click that might change the page, take a new snapshot
- DO NOT waste time connecting the wallet — it's already connected
- DO NOT just click through pages — the crawler already did that
- Focus on FORM INTERACTIONS: fill inputs, submit, observe errors/confirmations
- Try INVALID inputs: 0, -1, 999999, empty — for every input field you find
- Try DIFFERENT dropdown options: switch order types, switch assets
- When you find an error message or validation text, record it exactly
- You have ~30 tool calls. Spend them on form submissions and error discovery, not navigation

## REPORTING — USE THESE TOOLS TO RECORD FINDINGS
You have special reporting tools. Call them AS YOU DISCOVER things, not just at the end:

- **graph_query**: Query the knowledge graph to see what's been discovered. Use "all_flows" to see existing flows, "unconnected_components" to find gaps, "form_flows" to see detected forms, "constraints" to see business rules. START your exploration by querying the graph to know what's already known and what's missing.
- **report_flow**: When you discover a multi-step user flow. Call this with the flow name, steps, and category.
- **report_edge_case**: When you find a validation rule, error state, or boundary behavior. Call this with the description and expected behavior.

Call these tools DURING exploration, every time you discover something. Don't wait until the end.`;
}

export function createExplorerNode(browserCtx: BrowserCtx) {
  return async (state: AgentStateType) => {
    const { config, knowledgeGraph, crawlData } = state;

    console.log('━━━ Explorer: Deep interaction discovery ━━━');

    const model = new ChatOpenAI({
      model: config.explorerModel,
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
      },
      apiKey: config.apiKey,
      temperature: 0,
      maxTokens: 4096,
      timeout: 120000,
    });

    // Structured findings collector
    const findings: ExplorerFindings = { flows: [], edgeCases: [], validationRules: [], uiBehaviors: [] };
    let flowCounter = 0;
    let edgeCaseCounter = 0;

    // Reporting tools — explorer calls these to record findings into the KG
    const reportFlowTool = new DynamicStructuredTool({
      name: 'report_flow',
      description: 'Record a discovered user flow. Call this when you find a multi-step sequence that a user would perform.',
      schema: z.object({
        name: z.string().describe('Flow name (e.g., "Complete main action flow", "Submit form with valid data")'),
        steps: z.array(z.string()).describe('Ordered steps describing what to do'),
        category: z.string().describe('Category: trading, wallet, portfolio, earn, referral, navigation'),
        requiresFundedWallet: z.boolean().describe('Does this flow need funds in the wallet?'),
        priority: z.number().describe('1=critical, 2=important, 3=nice-to-have'),
      }),
      func: async ({ name, steps, category, requiresFundedWallet, priority }) => {
        const flow: KGFlow = {
          id: `flow:explorer:${flowCounter++}`,
          name,
          description: `Discovered by explorer: ${steps.length}-step flow`,
          pageId: `page:${new URL(browserCtx.page.url()).pathname}`,
          steps: steps.map((s, i) => ({ order: i, description: s, expectedOutcome: '' })),
          requiresFundedWallet,
          category,
          priority,
          tested: false,
          testResult: 'untested',
        };
        findings.flows.push(flow);
        console.log(`[Explorer] 📋 Flow: ${name} (${steps.length} steps)`);
        return `Flow recorded: ${name}`;
      },
    });

    const reportEdgeCaseTool = new DynamicStructuredTool({
      name: 'report_edge_case',
      description: 'Record a discovered edge case, validation rule, or error behavior.',
      schema: z.object({
        name: z.string().describe('Short name describing the edge case'),
        description: z.string().describe('What you observed in detail'),
        inputValue: z.string().optional().describe('The input that triggered this (e.g., "0", "-1")'),
        expectedBehavior: z.string().describe('What the UI does (e.g., "Button changes to Add Funds")'),
      }),
      func: async ({ name, description, inputValue, expectedBehavior }) => {
        const ec: KGEdgeCase = {
          id: `edgecase:explorer:${edgeCaseCounter++}`,
          flowId: '',
          name,
          description,
          inputValue,
          expectedBehavior,
          tested: false,
          testResult: 'untested',
        };
        findings.edgeCases.push(ec);
        console.log(`[Explorer] ⚠️ Edge case: ${name}`);
        return `Edge case recorded: ${name}`;
      },
    });

    // Graph query tool — lets explorer ask what's been discovered and what's missing
    const graphQueryTool = new DynamicStructuredTool({
      name: 'graph_query',
      description: 'Query the knowledge graph. Use this to find out what flows exist, what components have not been explored, and what gaps remain.',
      schema: z.object({
        query: z.enum([
          'all_flows',           // get all discovered user flows
          'unconnected_components', // components with no edges (unexplored)
          'form_flows',          // detected form-based flows with permutations
          'constraints',         // all constraints from docs
          'pages_summary',       // quick overview of all pages
        ]).describe('What to query from the graph'),
      }),
      func: async ({ query }) => {
        const g = DAppGraph.deserialize(state.graph);
        switch (query) {
          case 'all_flows': {
            const flows = g.getAllFlows();
            if (flows.length === 0) return 'No flows discovered yet. Try interacting with forms and multi-step sequences.';
            return flows.map(f => {
              const permStr = f.permutations?.length
                ? `\n  Variations: ${f.permutations.map(p => `${p.field} (${p.options.join('/')})`).join(', ')}`
                : '';
              const constraintStr = f.constraints.length > 0
                ? `\n  Constraints: ${f.constraints.map(c => `${c.name}=${c.value}`).join(', ')}`
                : '';
              return `- ${f.name}\n  Selectors: ${f.selectors.join(' → ')}${permStr}${constraintStr}`;
            }).join('\n\n');
          }
          case 'unconnected_components': {
            const uncomp = g.getUnconnectedComponents();
            if (uncomp.length === 0) return 'All components have been connected! Good coverage.';
            return `${uncomp.length} unexplored components:\n` +
              uncomp.map(c => `- ${c.role || 'unknown'} "${c.label}" on ${c.pageId} → ${c.selector || 'no selector'}`).join('\n');
          }
          case 'form_flows': {
            const forms = g.getFormFlows();
            if (forms.length === 0) return 'No form flows detected.';
            return forms.map(f => {
              const steps = f.path.map(n => `${n.role || n.type}: "${n.label}"`).join(' → ');
              const perms = f.permutations?.map(p => `${p.field}: [${p.options.join(', ')}]`).join('\n  ') || 'none';
              return `Form: ${f.name}\n  Steps: ${steps}\n  Permutations:\n  ${perms}`;
            }).join('\n\n');
          }
          case 'constraints': {
            const constraintNodes = [...g.nodes.values()].filter(n => n.type === 'constraint');
            if (constraintNodes.length === 0) return 'No constraints found in docs.';
            return constraintNodes.map(c => `- ${c.label} (applies to: ${
              (g.outEdges.get(c.id) || []).map(e => g.nodes.get(e.to)?.label || e.to).join(', ')
            })`).join('\n');
          }
          case 'pages_summary': {
            const pages = [...g.nodes.values()].filter(n => n.type === 'page');
            return pages.map(p => {
              const comps = (g.outEdges.get(p.id) || []).filter(e => e.type === 'CONTAINS').length;
              return `- ${p.label} (${p.data?.url || '/'}) — ${comps} components`;
            }).join('\n');
          }
          default:
            return 'Unknown query type';
        }
      },
    });

    const allTools = [...createAllTools(browserCtx), reportFlowTool, reportEdgeCaseTool, graphQueryTool];
    const toolsByName = new Map(allTools.map(t => [t.name, t]));
    const modelWithTools = model.bindTools(allTools);

    // Navigate to dApp and ensure wallet is connected
    await browserCtx.page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserCtx.page.waitForTimeout(3000);

    // Verify wallet is connected — if not, connect it
    const walletAddr = await browserCtx.page.evaluate(() =>
      (window as any).ethereum?.selectedAddress || null
    ).catch(() => null);

    if (!walletAddr) {
      console.log('[Explorer] Wallet not connected — attempting connect (hard-capped at 45s so we never hang)');
      // Hard cap the whole connect block. Modern dApps use one of three wallet modals:
      //   1. RainbowKit: click "Connect Wallet" → "MetaMask" button appears directly
      //   2. Wagmi: same as RainbowKit
      //   3. Privy: click "Login" → "Continue with a wallet" → "MetaMask"
      // We try path 1/2 first (most common), fall back to path 3, and if neither
      // fires within the cap we log a warning and continue without a wallet. The
      // explorer can still do a lot of useful work on a read-only crawl.
      const connectPromise = (async () => {
        const loginBtn = browserCtx.page.getByRole('button', { name: /^(Login|Connect|Connect Wallet|Get Started)$/i }).first();
        if (!(await loginBtn.isVisible({ timeout: 5000 }).catch(() => false))) return 'no-login-button';
        await loginBtn.click().catch(() => {});
        await browserCtx.page.waitForTimeout(2000);

        // Path 1/2 — look for a direct MetaMask button (RainbowKit/Wagmi).
        const mmDirect = browserCtx.page.getByRole('button', { name: /^MetaMask$/i }).first();
        if (await mmDirect.isVisible({ timeout: 3000 }).catch(() => false)) {
          await mmDirect.click().catch(() => {});
        } else {
          // Path 3 — Privy: click "Continue with a wallet", then MetaMask.
          const walletOption = browserCtx.page.getByRole('button', { name: /Continue with (a )?wallet/i }).first();
          if (await walletOption.isVisible({ timeout: 3000 }).catch(() => false)) {
            await walletOption.click().catch(() => {});
            await browserCtx.page.waitForTimeout(1000);
            const mmBtn = browserCtx.page.getByRole('button', { name: /MetaMask/i }).first();
            if (await mmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await mmBtn.click().catch(() => {});
            }
          }
        }

        const { executeWalletTool } = await import('../../browser/wallet.js');
        await executeWalletTool('wallet_approve_connection', {}, browserCtx).catch(() => {});
        await browserCtx.page.waitForTimeout(2000).catch(() => {});
        await browserCtx.page.bringToFront().catch(() => {});
        await browserCtx.page.keyboard.press('Escape').catch(() => {});
        return 'attempted';
      })();

      const timeout = new Promise<string>(r => setTimeout(() => r('timeout'), 45_000));
      const result = await Promise.race([connectPromise, timeout]).catch(e => `error:${(e as Error).message}`);
      console.log(`[Explorer] Wallet connect result: ${result}`);

      const addr = await browserCtx.page.evaluate(() =>
        (window as any).ethereum?.selectedAddress || null
      ).catch(() => null);
      console.log(`[Explorer] Wallet: ${addr || 'not connected — explorer continues in read-only mode'}`);
    } else {
      console.log(`[Explorer] Wallet already connected: ${walletAddr}`);
    }

    const dappProfile = crawlData?.dappProfile || '';
    const docsContent = crawlData?.context?.docsContent || '';
    const systemPrompt = buildExplorerSystemPrompt(knowledgeGraph, crawlData, dappProfile || docsContent);

    // ── Coordinator: generate per-page exploration tasks from graph ──
    const graph = DAppGraph.deserialize(state.graph);
    const explorationTasks: { page: string; url: string; budget: number; instruction: string }[] = [];

    for (const page of knowledgeGraph.pages) {
      const pageComps = knowledgeGraph.components.filter(c => c.pageId === page.id);
      const pageForm = [...graph.nodes.values()].find(n => n.type === 'form' && n.pageId === page.id);
      const unconnected = graph.getUnconnectedComponents().filter(c => c.pageId === page.id);

      // Budget proportional to complexity
      const hasForm = !!pageForm;
      const compCount = pageComps.length;
      const budget = hasForm ? Math.max(40, compCount * 2) : Math.max(15, compCount);

      // Build focused instruction
      const fullPageUrl = page.url.startsWith('http') ? page.url : `${config.url.replace(/\/[^/]*$/, '')}${page.url}`;
      let instruction = `You are on ${fullPageUrl}. DO NOT use browser_navigate — you are already on the correct page. Start with browser_snapshot.\n`;
      if (pageForm) {
        const configEdges = (graph.inEdges.get(pageForm.id) || []).filter(e => e.type === 'CONFIGURES');
        const configComps = configEdges.map(e => graph.nodes.get(e.from)).filter(Boolean);
        const submitEdge = (graph.inEdges.get(pageForm.id) || []).find(e => e.type === 'SUBMITS');
        const submitComp = submitEdge ? graph.nodes.get(submitEdge.from) : null;
        const optionEdges = configEdges.flatMap(e => (graph.outEdges.get(e.from) || []).filter(oe => oe.type === 'HAS_OPTION'));
        const options = optionEdges.map(e => graph.nodes.get(e.to)?.label).filter(Boolean);

        instruction += `\nThis page has a FORM with ${configComps.length} configurable fields:\n`;
        configComps.forEach(c => { instruction += `  - ${c!.role}: "${c!.label}" → ${c!.selector || 'no selector'}\n`; });
        if (options.length > 0) instruction += `  Options: ${options.join(', ')}\n`;
        if (submitComp) instruction += `  Submit: "${submitComp.label}" → ${submitComp.selector || ''}\n`;

        instruction += `\nYou MUST:\n`;
        instruction += `1. Complete the FULL form submission for EACH option combination (e.g., each dropdown value)\n`;
        instruction += `2. For EACH input, try: valid value, 0, -1, very large number\n`;
        instruction += `3. Toggle each switch ON and OFF and try submitting with each state\n`;
        instruction += `4. Report EVERY complete flow and edge case immediately\n`;
      }
      if (unconnected.length > 0) {
        instruction += `\nUnexplored components on this page (interact with ALL of these):\n`;
        unconnected.slice(0, 15).forEach(c => { instruction += `  - ${c.role} "${c.label}"\n`; });
      }

      explorationTasks.push({ page: page.name, url: page.url, budget, instruction });
    }

    console.log(`[Explorer] Coordinator created ${explorationTasks.length} tasks:`);
    const totalBudget = explorationTasks.reduce((s, t) => s + t.budget, 0);
    explorationTasks.forEach(t => console.log(`  ${t.page}: ${t.budget} iterations`));
    console.log(`[Explorer] Total budget: ${totalBudget} iterations`);

    // ── Execute each task as a focused exploration loop ──
    let totalIterations = 0;
    let findingsText = '';

    for (const task of explorationTasks) {
      console.log(`\n[Explorer] ── Task: ${task.page} (${task.budget} iterations) ──`);

      // Navigate to page
      const pageUrl = task.url.startsWith('http') ? task.url : `${config.url.replace(/\/[^/]*$/, '')}${task.url}`;
      try {
        await browserCtx.page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await browserCtx.page.waitForTimeout(2000);
      } catch (navErr) {
        console.warn(`[Explorer] Failed to navigate to ${pageUrl}: ${(navErr as Error).message} — skipping task`);
        continue;
      }

      // Fresh message context per task (keeps context focused)
      const taskMessages: BaseMessage[] = [
        new SystemMessage(systemPrompt),
        new HumanMessage(task.instruction),
      ];

      let taskIterations = 0;
      let consecutiveNoProgress = 0;
      const actionHistory: string[] = [];
      let lastSnapshotHash = '';

      while (taskIterations < task.budget) {
        taskIterations++;
        totalIterations++;

        console.log(`[Explorer] ${task.page} ${taskIterations}/${task.budget} (${findings.flows.length} flows, ${findings.edgeCases.length} edge cases)...`);

        const response = await modelWithTools.invoke(taskMessages);
        taskMessages.push(response);

        const toolCalls = response.tool_calls || [];

        if (toolCalls.length === 0) {
          const text = typeof response.content === 'string' ? response.content : '';
          if (text) findingsText += `\n## ${task.page}\n${text}\n`;
          console.log(`[Explorer] ${task.page} finished after ${taskIterations} iterations`);
          break;
        }

        let madeProgress = false;

        for (const tc of toolCalls) {
          const tool = toolsByName.get(tc.name);
          if (!tool) {
            taskMessages.push(new ToolMessage({ content: `Unknown tool: ${tc.name}`, tool_call_id: tc.id! }));
            continue;
          }

          // Duplicate detection
          const actionKey = `${tc.name}:${JSON.stringify(tc.args)}`;
          const duplicateCount = actionHistory.filter(a => a === actionKey).length;
          if (duplicateCount >= 2 && tc.name !== 'browser_snapshot' && tc.name !== 'graph_query') {
            taskMessages.push(new ToolMessage({ content: `⚠️ Already done ${duplicateCount} times. Try something different.`, tool_call_id: tc.id! }));
            consecutiveNoProgress++;
            continue;
          }
          actionHistory.push(actionKey);

          try {
            const result = await (tool as any).invoke(tc.args);
            const output = typeof result === 'string' ? result : JSON.stringify(result);

            if (tc.name === 'browser_click' || tc.name === 'browser_type' || tc.name === 'report_flow' || tc.name === 'report_edge_case') {
              madeProgress = true;
            } else if (tc.name === 'browser_snapshot') {
              const hash = output.slice(0, 200);
              if (hash !== lastSnapshotHash) madeProgress = true;
              lastSnapshotHash = hash;
            }

            if (tc.name !== 'browser_snapshot') {
              console.log(`[Explorer] ${tc.name} → ${output.slice(0, 120)}`);
            } else {
              console.log(`[Explorer] browser_snapshot → ${output.length} chars`);
            }
            taskMessages.push(new ToolMessage({ content: output, tool_call_id: tc.id! }));
          } catch (e) {
            const err = `Error: ${(e as Error).message}`;
            console.log(`[Explorer] ${tc.name} → FAIL: ${err.slice(0, 120)}`);
            taskMessages.push(new ToolMessage({ content: err, tool_call_id: tc.id! }));
          }
        }

        // Track progress stalls
        if (madeProgress) {
          consecutiveNoProgress = 0;
        } else {
          consecutiveNoProgress++;
        }

        // Auto-stop task if stuck
        if (consecutiveNoProgress >= 8) {
          console.log(`[Explorer] ${task.page}: stuck for 8 iterations — moving to next task`);
          break;
        }

        // Budget warning for this task
        if (taskIterations === task.budget - 5) {
          taskMessages.push(new HumanMessage(`⚠️ 5 iterations left for this page. Call report_flow for ALL flows you found on ${task.page}. Call report_edge_case for ALL edge cases.`));
        }
      }
    }

    console.log(`\n[Explorer] All tasks complete. ${totalIterations} total iterations.`);
    console.log(`[Explorer] Structured findings: ${findings.flows.length} flows, ${findings.edgeCases.length} edge cases`);

    // Build KG update from structured findings (not text parsing!)
    const kgUpdate: KnowledgeGraph = {
      pages: [], components: [], actions: [],
      flows: findings.flows,
      edgeCases: findings.edgeCases,
      testCases: [], edges: [],
      features: [], assets: [], dropdownOptions: [], docSections: [], apiEndpoints: [], constraints: [], contracts: [],
    };

    // Persist findings
    const { writeFileSync } = await import('fs');
    const { join } = await import('path');
    writeFileSync(join(config.outputDir, 'explorer-findings.txt'), findingsText);
    writeFileSync(join(config.outputDir, 'explorer-findings-structured.json'), JSON.stringify(findings, null, 2));

    return {
      knowledgeGraph: kgUpdate,
    };
  };
}

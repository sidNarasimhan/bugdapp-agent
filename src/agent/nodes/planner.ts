import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, TestPlan, KnowledgeGraph, KGFlow, ComputedFlow } from '../state.js';
import { DAppGraph } from '../state.js';
import { segmentModules, type Module } from './module-segmenter.js';
import type { Comprehension } from './comprehension.js';

/**
 * Load the comprehension artifact for this dApp if the comprehension node has
 * already run (it writes `comprehension.json` to the output dir). Returns null
 * if absent — caller should gracefully degrade to raw KG reasoning in that case.
 */
function loadComprehension(outputDir: string): Comprehension | null {
  const p = join(outputDir, 'comprehension.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')) as Comprehension; } catch { return null; }
}

/**
 * Render the comprehension as a compact prompt block that the planner LLM can
 * use as ground truth: archetype, primary flows, constraints, risks, adversarial
 * targets. Kept tight — this is additive context on top of the KG summary.
 */
function renderComprehensionBlock(c: Comprehension): string {
  const lines: string[] = [`## DOMAIN COMPREHENSION (ground-truth understanding of this dApp — use as primary context)`];
  lines.push(`**Archetype:** ${c.archetype} (confidence ${c.archetypeConfidence.toFixed(2)})`);
  if (c.chains.length > 0) lines.push(`**Chains:** ${c.chains.join(', ')}`);
  lines.push(`**Summary:** ${c.summary}`);
  if (c.archetypeEvidence.length > 0) {
    lines.push(`**Evidence:** ${c.archetypeEvidence.slice(0, 3).join('; ')}`);
  }
  if (c.primaryFlows.length > 0) {
    lines.push(`\n### Primary flows (generate a test for each — these are what users ACTUALLY do)`);
    for (const f of c.primaryFlows) {
      const inputs = f.inputs.map(i => `${i.name}:${i.type}${i.unit ? `(${i.unit})` : ''}`).join(', ');
      lines.push(`- **[${f.category} / P${f.priority} / ${f.riskClass}] ${f.name}** — ${f.rationale}`);
      lines.push(`  Entities: ${f.entities.join(', ') || 'none'}`);
      if (inputs) lines.push(`  Inputs: ${inputs}`);
      lines.push(`  Expected: ${f.expectedOutcome}`);
      if (f.contractEvents?.length) lines.push(`  On-chain events: ${f.contractEvents.join(', ')}`);
      lines.push(`  Funded-wallet required: ${f.requiresFundedWallet}`);
    }
  }
  if (c.constraints.length > 0) {
    lines.push(`\n### Constraints (each needs a boundary test)`);
    for (const k of c.constraints) {
      lines.push(`- [${k.scope ?? 'all'}] **${k.name} = ${k.value}** → ${k.testImplication}`);
    }
  }
  if (c.edgeCases.length > 0) {
    lines.push(`\n### Edge cases (test each)`);
    for (const e of c.edgeCases) {
      lines.push(`- ${e.name}: ${e.rationale}`);
    }
  }
  if (c.adversarialTargets.length > 0) {
    lines.push(`\n### Adversarial targets (web3-specific, generate one scenario per target)`);
    lines.push(c.adversarialTargets.map(t => `- ${t}`).join('\n'));
  }
  if (c.risks.length > 0) {
    lines.push(`\n### Risks (informational — shape assertion depth)`);
    for (const r of c.risks) {
      lines.push(`- [${r.severity}/${r.category}] ${r.name}: ${r.description}`);
    }
  }
  return lines.join('\n');
}

function buildPlannerPrompt(kg: KnowledgeGraph, crawlData: any): string {
  const pages = kg.pages.map(p => `- ${p.name} (${p.url}, ${p.elementCount} elements)`).join('\n');
  const flows = kg.flows.map(f =>
    `- [P${f.priority}] [${f.category}] ${f.name} — ${f.steps.length} steps${f.requiresFundedWallet ? ' [NEEDS FUNDS]' : ''}${f.tested ? ` [${f.testResult}]` : ' [UNTESTED]'}`
  ).join('\n');
  const edgeCases = kg.edgeCases.map(e =>
    `- ${e.name}${e.tested ? ` [${e.testResult}]` : ' [UNTESTED]'}`
  ).join('\n');

  // Component summary
  const components = kg.components
    .filter(c => !c.disabled && c.name)
    .slice(0, 100)
    .map(c => `- ${c.pageId}: ${c.role} "${c.name}" → ${c.selector}`)
    .join('\n');

  // Interaction insights
  const keyInteractions = (crawlData?.interactions || [])
    .filter((ix: any) => ix.success && (ix.domChanges?.appeared?.length > 2 || ix.walletInteraction))
    .slice(0, 20)
    .map((ix: any) => `- Click "${ix.elementName}" → ${ix.domChanges?.appeared?.length || 0} new elements${ix.walletInteraction ? ' [WALLET]' : ''}`)
    .join('\n');

  // Rich KG data
  const features = kg.features.map(f =>
    `- ${f.name}: ${f.description.slice(0, 150)}${f.constraints ? ` [Constraints: ${f.constraints}]` : ''}`
  ).join('\n');

  const assets = kg.assets.length > 0
    ? Object.entries(
        kg.assets.reduce((groups, a) => {
          if (!groups[a.group]) groups[a.group] = [];
          groups[a.group].push(`${a.symbol}${a.maxLeverage ? ` (max ${a.maxLeverage}x)` : ''}`);
          return groups;
        }, {} as Record<string, string[]>)
      ).map(([group, symbols]) => `  ${group}: ${symbols.join(', ')}`).join('\n')
    : 'No assets detected';

  const dropdowns = [...new Set(kg.dropdownOptions.map(d => d.componentId))].map(compId => {
    const opts = kg.dropdownOptions.filter(d => d.componentId === compId).map(d => d.value);
    return `- ${compId}: ${opts.join(', ')}`;
  }).join('\n');

  const docSummary = kg.docSections
    .slice(0, 10)
    .map(d => `- ${d.title}: ${d.content.slice(0, 200)}`)
    .join('\n');

  const apiSummary = kg.apiEndpoints
    .slice(0, 10)
    .map(a => `- ${a.path}: ${a.description}`)
    .join('\n');

  return `You are a senior QA test strategist. You are given complete knowledge about a dApp. Your job is to generate tests that a real user would perform — complete actions with specific parameters, not UI element checks.

## HOW TO THINK ABOUT TESTS
DO NOT think "does button X work?" — think "what would a user actually DO with this dApp?"

Every test should be a COMPLETE user action with SPECIFIC parameters. For example, if the dApp has forms with multiple options/items/settings:
- Generate tests for EACH meaningful combination of options
- Use SPECIFIC values in every test, not "enter a value"
- Each test should complete the full action (fill form → submit → verify result)

If the dApp has multiple options/choices/modes, cover the important combinations:
- Vary the selections across tests
- Vary the input values
- Both happy path (valid inputs) AND boundary conditions (at limits, just over limits)

DO NOT test UI elements in isolation. "Toggle switch X" is NOT a test. "Complete the full workflow with switch X enabled vs disabled" IS a test.

DO NOT generate tests like "verify button is visible" or "click percentage buttons". Those are NOT user flows. A user flow is: "I want to [achieve goal] using [specific item] with [specific parameters]."

## PAGES
${pages}

## DISCOVERED USER FLOWS
${flows}

## FEATURES & CAPABILITIES (from documentation)
${features || 'No features extracted.'}

## TRADEABLE ASSETS BY GROUP
${assets}

## DROPDOWN OPTIONS
${dropdowns || 'No dropdowns detected.'}

## KEY COMPONENTS (with Playwright selectors)
${components}

## EDGE CASES FOUND
${edgeCases || 'None explicitly found — generate common ones: zero/empty input, exceeding limits, insufficient balance, wrong network, disconnected wallet, rapid repeated actions.'}

## DOCUMENTATION SECTIONS
${docSummary || 'No docs available.'}

## API ENDPOINTS
${apiSummary || 'No APIs detected.'}

## KEY INTERACTIONS (what happened when buttons were clicked)
${keyInteractions}

## CONSTRAINTS & BUSINESS RULES (from documentation — EACH ONE needs a test!)
${kg.constraints.map(c => `- **${c.name}** = ${c.value}${c.scope && c.scope !== 'all' ? ` (scope: ${c.scope})` : ''}
  Test: ${c.testImplication}`).join('\n') || 'No constraints extracted — look for limits, thresholds, and restrictions in the docs above.'}

## OUTPUT FORMAT
Return a JSON object with this exact structure:
{
  "suites": [
    {
      "name": "Suite Name",
      "description": "What this suite tests",
      "tests": [
        {
          "id": "test-001",
          "name": "Descriptive test name",
          "flowId": "flow:xxx (if testing a known flow, otherwise omit)",
          "steps": [
            "Step 1: Navigate to /trade",
            "Step 2: Click Login button",
            "Step 3: Approve wallet connection",
            "Step 4: Select an item/option from dropdown",
            "Step 5: Fill in required input fields",
            "Step 6: Click the primary action button"
          ],
          "expectedOutcome": "Order confirmation modal appears with position details",
          "requiresFundedWallet": true,
          "priority": 1
        }
      ]
    }
  ]
}

## RULES
- Steps must be SPECIFIC: use actual element names and values from the data above
- Each test must have a clear expected outcome (what the UI should show)
- Include edge case tests for EVERY constraint and boundary condition found
- Group tests into logical suites (Wallet, Trading, Portfolio, Navigation, EdgeCases)
- Priority 1 = critical path, 2 = important feature, 3 = nice-to-have
- For flows that need funds, mark requiresFundedWallet: true
- Cover ALL discovered flows, ALL edge cases, ALL constraints — don't skip anything`;
}

function buildModulePlannerPrompt(mod: Module, kg: KnowledgeGraph, crawlData: any, computedFlows: ComputedFlow[]): string {
  // Get components for this module
  const modCompIds = new Set(mod.components);
  const modComps = kg.components.filter(c => modCompIds.has(c.id));

  // Get constraints for this module
  const modConstraintIds = new Set(mod.constraints);
  const modConstraints = kg.constraints.filter(c => modConstraintIds.has(c.id));
  // If no specific constraints, include all (they might be relevant)
  const constraints = modConstraints.length > 0 ? modConstraints : kg.constraints;

  // Get features
  const modFeatureIds = new Set(mod.features);
  const modFeatures = kg.features.filter(f => modFeatureIds.has(f.id));

  // Get assets if relevant
  const modAssetIds = new Set(mod.assets);
  const modAssets = modAssetIds.size > 0 ? kg.assets.filter(a => modAssetIds.has(a.id)) : [];
  const assetsByGroup = modAssets.reduce((groups, a) => {
    if (!groups[a.group]) groups[a.group] = [];
    groups[a.group].push(a);
    return groups;
  }, {} as Record<string, typeof modAssets>);

  // Get interactions for this page
  const interactions = (crawlData?.interactions || [])
    .filter((ix: any) => ix.success && ix.domChanges?.appeared?.length > 0)
    .slice(0, 15);

  // dApp profile for context
  const dappProfile = crawlData?.dappProfile?.slice(0, 3000) || '';

  return `You are a senior QA test strategist creating DEEP, SPECIFIC tests for ONE module of a dApp.

## DAPP CONTEXT (read this to understand the product)
${dappProfile}

## MODULE: ${mod.name}
${mod.description}

## COMPONENTS IN THIS MODULE (with Playwright selectors)
${modComps.map(c => `- ${c.role} "${c.name}" → page.${c.selector}${c.dynamic ? ' ⚠️ DYNAMIC VALUE' : ''}`).join('\n') || 'No components.'}

## USER FLOWS (discovered from graph traversal — generate tests for EACH)
${computedFlows.map(f => {
  const steps = f.path.map(n => `${n.role || n.type}: "${n.label}"${n.selector ? ` → page.${n.selector}` : ''}`).join('\n    ');
  const perms = f.permutations?.length
    ? `\n  VARIATIONS (test different combinations):\n${f.permutations.map(p => `    - ${p.field}: ${p.options.join(', ')}`).join('\n')}`
    : '';
  const constr = f.constraints.length > 0
    ? `\n  CONSTRAINTS (generate boundary tests for each):\n${f.constraints.map(c => `    - ${c.name} = ${c.value}: ${c.testImplication}`).join('\n')}`
    : '';
  return `### ${f.name}${f.requiresFundedWallet ? ' [NEEDS FUNDS]' : ''}
  Steps:
    ${steps}${perms}${constr}`;
}).join('\n\n') || 'No flows discovered — generate tests from the components listed above.'}

## EXPLORER-DISCOVERED FLOWS (verified by actually using the dApp)
${kg.flows.map(f => `- ${f.name} [${f.category}]: ${f.steps.map(s => s.description).join(' → ')}`).join('\n') || 'None.'}

## FEATURES
${modFeatures.map(f => `- ${f.name}: ${f.description.slice(0, 200)}`).join('\n') || 'No features.'}

${modAssets.length > 0 ? `## AVAILABLE ASSETS (${modAssets.length} total)
${Object.entries(assetsByGroup).map(([group, assets]) => {
  const examples = assets.slice(0, 8).map(a => `${a.symbol}${a.maxLeverage ? ` (max ${a.maxLeverage}x)` : ''}`);
  return `- ${group}: ${examples.join(', ')}${assets.length > 8 ? '...' : ''}`;
}).join('\n')}` : ''}

## CONSTRAINTS & BUSINESS RULES (EVERY constraint needs tests — both valid and boundary)
${constraints.map(c => `- **${c.name}** = ${c.value}${c.scope && c.scope !== 'all' ? ` (${c.scope})` : ''}
  → ${c.testImplication}`).join('\n') || 'No constraints found.'}

## DROPDOWN OPTIONS
${kg.dropdownOptions.filter(d => modCompIds.has(d.componentId)).map(d => `- ${d.componentId}: ${d.value}`).join('\n') || 'None.'}

## INTERACTIONS (what clicking things does)
${interactions.map((ix: any) => `- ${ix.action} "${ix.elementName}" → ${ix.domChanges?.appeared?.length} new elements`).join('\n') || 'None.'}

## EDGE CASES DISCOVERED (from exploration)
${kg.edgeCases.map(e => `- ${e.name}: ${e.description}${e.inputValue ? ` (input: ${e.inputValue})` : ''} → ${e.expectedBehavior}`).join('\n') || 'None found yet.'}

## HOW TO GENERATE TESTS
Think about what a REAL USER would do with this module. Not "does button work" but "user wants to accomplish a goal."

Look at the components, options, and features above. For each COMPLETE ACTION a user can perform:
- Generate a test with SPECIFIC values (not "enter a value" — say exactly what)
- Complete the FULL action from start to finish: configure → submit → verify outcome
- Vary the inputs across tests to cover different paths through the same flow

For EVERY constraint listed above, generate boundary tests:
- At the exact limit (should succeed)
- Just over the limit (should fail/warn)

NEVER test a UI element in isolation. Every toggle, dropdown, or input must be tested as PART of completing a real user goal.

RULES:
1. Use EXACT selectors from the component list (page.getByRole...)
2. DON'T hardcode dynamic values (prices, balances) — use regex or relative checks
3. Each step must specify the exact selector and value
4. Mark tests that need funded wallet as requiresFundedWallet: true
5. Generate AS MANY tests as needed to cover all meaningful combinations — no limit

## OUTPUT FORMAT
Return a JSON object:
{
  "tests": [
    {
      "id": "unique-id",
      "name": "Specific descriptive name",
      "steps": [
        "Step 1: Click page.getByRole('button', { name: 'X' }).first()",
        "Step 2: Fill page.getByRole('spinbutton').first() with '10'",
        "Step 3: Verify page.getByText(/expected/) is visible"
      ],
      "expectedOutcome": "Specific verifiable outcome",
      "requiresFundedWallet": false,
      "priority": 1
    }
  ]
}`;
}

/**
 * Batch KG flows into manageable groups for LLM calls.
 * Generic: finds the dimension with the most unique values and groups by it.
 * Works for any dApp — no hardcoded asset groups or categories.
 */
// Default batch size of 15 flows. Larger batches (we used to default 50) make
// the LLM call slow + flaky on dApps with rich navigation surfaces (Morpho's
// "markets" module had 45 flows in one batch and the planner hung indefinitely
// on 2026-04-13). 15 fits comfortably in deepseek-v3's effective context with
// fast-enough responses, and we just issue more (parallel-friendly) calls.
function batchFlows(flows: KGFlow[], maxPerBatch: number = 15): { label: string; flows: KGFlow[] }[] {
  if (flows.length <= maxPerBatch) {
    return [{ label: 'all', flows }];
  }

  // Strategy 1: group by the flow description's first token group (e.g. asset symbol, action type)
  // Parse the description to find a common grouping key
  const groupMap = new Map<string, KGFlow[]>();

  for (const flow of flows) {
    // Try to extract a grouping key from the flow description
    // Computed flows have descriptions like "ETH-USD (CRYPTO1): Market, on, Long"
    // Explorer flows have descriptions like "3-step flow on /trade"
    const descMatch = flow.description.match(/\(([^)]+)\)/);
    const categoryMatch = flow.category;
    const key = descMatch ? descMatch[1] : categoryMatch || 'other';

    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(flow);
  }

  // If grouping produced reasonable batches, use it
  if (groupMap.size > 1 && groupMap.size < flows.length / 2) {
    const batches: { label: string; flows: KGFlow[] }[] = [];
    for (const [key, groupFlows] of groupMap) {
      // If a group is still too large, sub-batch it
      if (groupFlows.length > maxPerBatch) {
        for (let i = 0; i < groupFlows.length; i += maxPerBatch) {
          const chunk = groupFlows.slice(i, i + maxPerBatch);
          batches.push({ label: `${key} (${i / maxPerBatch + 1})`, flows: chunk });
        }
      } else {
        batches.push({ label: key, flows: groupFlows });
      }
    }
    return batches;
  }

  // Strategy 2: just chunk by size
  const batches: { label: string; flows: KGFlow[] }[] = [];
  for (let i = 0; i < flows.length; i += maxPerBatch) {
    const chunk = flows.slice(i, i + maxPerBatch);
    batches.push({ label: `batch-${i / maxPerBatch + 1}`, flows: chunk });
  }
  return batches;
}

function buildBatchPlannerPrompt(
  mod: Module,
  batchLabel: string,
  batchFlows: KGFlow[],
  kg: KnowledgeGraph,
  crawlData: any,
  computedFlows: ComputedFlow[],
): string {
  const modCompIds = new Set(mod.components);
  const modComps = kg.components.filter(c => modCompIds.has(c.id));
  const constraints = kg.constraints;
  const dappProfile = crawlData?.dappProfile?.slice(0, 2000) || '';

  // Summarize the flows in this batch
  const flowSummary = batchFlows.slice(0, 60).map(f => {
    const stepSummary = f.steps.map(s => s.description).join(' → ');
    return `- ${f.name}: ${stepSummary}`;
  }).join('\n');

  // Get unique dimension values in this batch for context
  const dimensions = new Map<string, Set<string>>();
  for (const f of batchFlows) {
    for (const step of f.steps) {
      const setMatch = step.description.match(/^Set (.+?) to "(.+?)"$/);
      if (setMatch) {
        if (!dimensions.has(setMatch[1])) dimensions.set(setMatch[1], new Set());
        dimensions.get(setMatch[1])!.add(setMatch[2]);
      }
      const selectMatch = step.description.match(/^Select (.+?) from/);
      if (selectMatch) {
        if (!dimensions.has('item')) dimensions.set('item', new Set());
        dimensions.get('item')!.add(selectMatch[1]);
      }
    }
  }
  const dimSummary = [...dimensions.entries()]
    .map(([name, vals]) => `- ${name}: ${[...vals].slice(0, 10).join(', ')}${vals.size > 10 ? ` (+${vals.size - 10} more)` : ''}`)
    .join('\n');

  return `You are a senior QA test strategist. Generate COMPLETE, SPECIFIC test cases for a batch of user flows.

## DAPP CONTEXT
${dappProfile}

## MODULE: ${mod.name} — Batch: ${batchLabel}
${mod.description}

## COMPONENTS (with Playwright selectors)
${modComps.map(c => `- ${c.role} "${c.name}" → page.${c.selector}`).join('\n')}

## DIMENSIONS IN THIS BATCH
${dimSummary}

## USER FLOWS TO TEST (${batchFlows.length} flows — generate a test for EACH)
${flowSummary}

## GRAPH-COMPUTED FORM FLOWS (for reference — shows the form structure)
${computedFlows.slice(0, 3).map(f => {
  return `Form: ${f.name}\n  Permutations: ${f.permutations?.map(p => `${p.field}: [${p.options.join(', ')}]`).join(', ') || 'none'}`;
}).join('\n')}

## CONSTRAINTS (generate boundary tests for each)
${constraints.map(c => `- **${c.name}** = ${c.value}${c.scope && c.scope !== 'all' ? ` (${c.scope})` : ''} → ${c.testImplication}`).join('\n') || 'None.'}

## EDGE CASES
${kg.edgeCases.slice(0, 15).map(e => `- ${e.name}: ${e.expectedBehavior}`).join('\n') || 'None.'}

## RULES
1. Generate ONE test for EACH flow listed above — do NOT skip any
2. Each test must have SPECIFIC values for every input this dApp's form needs (amounts, numeric configs, entity choices — whatever this dApp's domain requires)
3. Use EXACT selectors from the component list
4. Complete the FULL action: configure all options → fill inputs → submit → verify
5. For any constraint with a numeric limit, include a boundary test at the limit and just past it
6. DON'T hardcode dynamic values (live prices, balances, rates) — use regex or relative checks
7. Mark requiresFundedWallet: true for any test that submits a transaction

## OUTPUT FORMAT
Return JSON: { "tests": [{ "id": "...", "name": "...", "steps": ["Step 1: ..."], "expectedOutcome": "...", "requiresFundedWallet": false, "priority": 1 }] }`;
}

function parseTestsFromResponse(content: string): any[] {
  try {
    const jsonMatch = content.match(/\{[\s\S]*"tests"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.tests || [];
    }
  } catch {}
  try {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      const parsed = JSON.parse(fenced[1]);
      return parsed.tests || [];
    }
  } catch {}
  return [];
}

export function createPlannerNode() {
  return async (state: AgentStateType) => {
    const { config, knowledgeGraph, crawlData } = state;

    console.log('━━━ Planner: Creating test strategy ━━━');

    // Pull comprehension (if the comprehension node has run) so the planner
    // can reason from a structured understanding rather than raw KG only.
    const comprehension = loadComprehension(config.outputDir);
    if (comprehension) {
      console.log(`[Planner] Loaded comprehension: ${comprehension.archetype} (conf ${comprehension.archetypeConfidence.toFixed(2)}), ${comprehension.primaryFlows.length} primary flows`);
    } else {
      console.log(`[Planner] No comprehension.json — falling back to raw KG reasoning`);
    }
    const comprehensionBlock = comprehension ? renderComprehensionBlock(comprehension) : '';

    const graph = DAppGraph.deserialize(state.graph);
    const allComputedFlows = graph.getAllFlows();
    console.log(`[Planner] Graph: ${graph.stats.nodes} nodes, ${graph.stats.edges} edges, ${allComputedFlows.length} computed flows`);
    console.log(`[Planner] KG: ${knowledgeGraph.flows.length} flows, ${knowledgeGraph.edgeCases.length} edge cases`);

    const model = new ChatOpenAI({
      model: config.plannerModel,
      configuration: { baseURL: 'https://openrouter.ai/api/v1' },
      apiKey: config.apiKey,
      temperature: 0,
      maxTokens: 16384,
    });

    const modules = segmentModules(knowledgeGraph);
    console.log(`[Planner] Detected ${modules.length} modules: ${modules.map(m => m.name).join(', ')}`);

    const plan: TestPlan = { suites: [] };

    for (const mod of modules) {
      // Get KG flows for this module
      const moduleKGFlows = knowledgeGraph.flows.filter(f =>
        f.pageId === mod.pageId || mod.pageId === 'shared'
      );
      // Get computed graph flows for this module
      const moduleGraphFlows = allComputedFlows.filter(f =>
        f.path.some(n => n.pageId === mod.pageId) || mod.pageId === 'shared'
      );

      // Batch the KG flows intelligently
      const batches = batchFlows(moduleKGFlows);
      console.log(`[Planner] ${mod.name}: ${moduleKGFlows.length} KG flows → ${batches.length} batches`);

      const suiteTests: any[] = [];

      for (const batch of batches) {
        console.log(`[Planner]   Batch "${batch.label}" (${batch.flows.length} flows)...`);

        // Prepend comprehension (if present) so the LLM generates tests that
        // match the dApp's actual archetype + primary flows instead of
        // templating from raw KG.
        const basePrompt = buildBatchPlannerPrompt(mod, batch.label, batch.flows, knowledgeGraph, crawlData, moduleGraphFlows);
        const prompt = comprehensionBlock ? `${comprehensionBlock}\n\n${basePrompt}` : basePrompt;

        try {
          const result = await model.invoke([
            new SystemMessage(prompt),
            new HumanMessage(`Generate test cases for the "${batch.label}" batch of "${mod.name}". One test per flow. Return ONLY JSON with a "tests" array.`),
          ]);

          const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
          const tests = parseTestsFromResponse(content);

          if (tests.length > 0) {
            suiteTests.push(...tests);
            console.log(`[Planner]     → ${tests.length} tests`);
          } else {
            console.warn(`[Planner]     → Failed to parse tests for batch "${batch.label}"`);
          }
        } catch (e) {
          console.error(`[Planner]     → Error: ${(e as Error).message}`);
        }
      }

      // If no KG flows (e.g. navigation module), fall back to original single-call approach
      if (moduleKGFlows.length === 0) {
        console.log(`[Planner]   No KG flows — using component-based planning...`);
        const basePrompt = buildModulePlannerPrompt(mod, knowledgeGraph, crawlData, moduleGraphFlows);
        const prompt = comprehensionBlock ? `${comprehensionBlock}\n\n${basePrompt}` : basePrompt;
        try {
          const result = await model.invoke([
            new SystemMessage(prompt),
            new HumanMessage(`Generate the test plan for "${mod.name}". Return ONLY JSON with a "tests" array.`),
          ]);
          const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
          const tests = parseTestsFromResponse(content);
          if (tests.length > 0) {
            suiteTests.push(...tests);
            console.log(`[Planner]     → ${tests.length} tests`);
          }
        } catch (e) {
          console.error(`[Planner]     → Error: ${(e as Error).message}`);
        }
      }

      if (suiteTests.length > 0) {
        plan.suites.push({
          name: mod.name,
          description: mod.description,
          tests: suiteTests.map((t: any, i: number) => ({
            ...t,
            id: t.id || `test-${mod.id}-${i}`,
          })),
        });
        console.log(`[Planner]   Total: ${suiteTests.length} tests for ${mod.name}`);
      }
    }

    const testCount = plan.suites.reduce((sum, s) => sum + s.tests.length, 0);
    console.log(`[Planner] Grand total: ${plan.suites.length} suites with ${testCount} tests`);

    writeFileSync(join(config.outputDir, 'test-plan.json'), JSON.stringify(plan, null, 2));

    const testCases = plan.suites.flatMap(suite =>
      suite.tests.map(t => ({
        id: `tc:${t.id}`,
        flowId: t.flowId,
        edgeCaseId: undefined,
        name: t.name,
        status: 'planned' as const,
        attempts: 0,
      }))
    );

    return {
      testPlan: plan,
      knowledgeGraph: {
        pages: [], components: [], actions: [], flows: [], edgeCases: [], features: [], assets: [], dropdownOptions: [], docSections: [], apiEndpoints: [], constraints: [],
        testCases,
        edges: [],
      },
    };
  };
}

import { writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, KGFlow, KGFlowStep, KGEdgeCase } from '../state.js';
import { DAppGraph, type ComputedFlow } from '../state.js';

/**
 * Flow Computer — deterministic node, no LLM, $0.
 *
 * Reads the graph's computed form flows (with permutations) and the KG's
 * assets/components, then generates ALL possible user flows as KG flows.
 *
 * This enriches the KG so the explorer and planner know every possible
 * action a user can take on the dApp.
 *
 * Generic — works on any dApp. The logic:
 *   1. Get all form flows from the graph (forms with inputs/toggles/dropdowns)
 *   2. Get all permutations for each form (dropdown options, switch states)
 *   3. Get assets if the form has an asset selector
 *   4. Cross-product: each asset × each permutation combo = one user flow
 *   5. Add constraint-based edge cases for boundary testing
 */
export function createFlowComputerNode() {
  return async (state: AgentStateType) => {
    const { knowledgeGraph: kg, config } = state;
    const graph = DAppGraph.deserialize(state.graph);

    console.log('━━━ Flow Computer: Computing all user flows ━━━');

    const allFlows: KGFlow[] = [];
    const allEdgeCases: KGEdgeCase[] = [];
    let flowCounter = 0;
    let edgeCaseCounter = 0;

    // Get computed form flows from graph (these have permutations)
    const formFlows = graph.getFormFlows();
    const revealFlows = graph.getRevealFlows();

    console.log(`[FlowComputer] ${formFlows.length} form flows, ${revealFlows.length} reveal flows`);

    for (const formFlow of formFlows) {
      const pageId = formFlow.path[0]?.pageId || '';
      const pageName = kg.pages.find(p => p.id === pageId)?.name || pageId;

      // ── 1. Detect clickable button pairs near the form (direction selectors) ──
      // Look for buttons on same page that come in opposing pairs
      const pageButtons = kg.components.filter(c =>
        c.pageId === pageId && c.role === 'button' && !c.disabled
      );

      // Find button pairs by checking for common opposing patterns
      const buttonPairCandidates = detectButtonPairs(pageButtons);

      // ── 2. Detect asset selector (button that opens a modal with asset options) ──
      // Heuristic: a button whose name looks like an asset symbol (e.g. "BTCUSD", "ETH")
      const assetSelector = pageButtons.find(b =>
        /^[A-Z]{2,}[-/]?[A-Z]*$/.test(b.name.replace(/[^A-Za-z/-]/g, '')) &&
        b.name.length <= 15
      );

      // ── 3. Gather all dimensions ──
      // Order matters for validation: switches/toggles first (visible on default page state),
      // then dropdowns (which may change page layout), then button pairs last.
      const switchDimensions: { name: string; options: string[]; selectors: string[] }[] = [];
      const dropdownDimensions: { name: string; options: string[]; selectors: string[] }[] = [];
      const pairDimensions: { name: string; options: string[]; selectors: string[] }[] = [];

      if (formFlow.permutations) {
        for (const perm of formFlow.permutations) {
          // Check if this is a switch (on/off) or a dropdown (named options)
          const isSwitch = perm.options.length === 2 && perm.options.includes('on') && perm.options.includes('off');
          if (isSwitch) {
            switchDimensions.push({
              name: perm.field,
              options: perm.options,
              selectors: perm.options.map(o => `getByRole('option', { name: '${o}' })`),
            });
          } else {
            dropdownDimensions.push({
              name: perm.field,
              options: perm.options,
              selectors: perm.options.map(o => `getByRole('option', { name: '${o}' })`),
            });
          }
        }
      }

      // Button pair dimensions (e.g. Long/Short)
      for (const pair of buttonPairCandidates) {
        pairDimensions.push({
          name: `${pair[0].name}/${pair[1].name}`,
          options: [pair[0].name, pair[1].name],
          selectors: pair.map(b => b.selector),
        });
      }

      // Final order: switches → direction pairs → dropdowns
      const dimensions = [...switchDimensions, ...pairDimensions, ...dropdownDimensions];

      // Assets dimension (if asset selector exists)
      const assetGroups = new Map<string, typeof kg.assets>();
      for (const asset of kg.assets) {
        if (!assetGroups.has(asset.group)) assetGroups.set(asset.group, []);
        assetGroups.get(asset.group)!.push(asset);
      }

      console.log(`[FlowComputer] Form "${formFlow.name}" on ${pageName}:`);
      console.log(`  Dimensions: ${dimensions.map(d => `${d.name} (${d.options.length})`).join(', ')}`);
      if (assetSelector) {
        console.log(`  Asset selector: "${assetSelector.name}" → ${kg.assets.length} assets in ${assetGroups.size} groups`);
      }

      // ── 4. Build the base flow steps from the form ──
      const baseSteps = buildBaseSteps(formFlow, kg);

      // ── 5. Generate flows: cross-product of all dimensions ──
      // If there's an asset selector, cross with asset groups (1 representative per group + full list)
      // If no assets, just cross the other dimensions

      if (kg.assets.length > 0 && assetSelector) {
        // Strategy: generate flows for EACH asset × EACH dimension combo
        const combos = crossProduct(dimensions);
        console.log(`  Combos: ${combos.length} dimension combinations`);

        for (const [groupName, assets] of assetGroups) {
          for (const asset of assets) {
            for (const combo of combos) {
              const flowId = `flow:computed:${flowCounter++}`;
              const comboDesc = combo.map(c => c.value).join(', ');
              const name = `${asset.symbol} ${comboDesc}`;

              const steps: KGFlowStep[] = [
                {
                  order: 0,
                  description: `Select ${asset.symbol} from asset selector`,
                  expectedOutcome: `Asset changes to ${asset.symbol}`,
                  selector: assetSelector.selector,
                },
                ...combo.map((c, i) => ({
                  order: i + 1,
                  description: `Set ${c.dimension} to "${c.value}"`,
                  expectedOutcome: `${c.dimension} set to ${c.value}`,
                  selector: c.selector,
                })),
                ...baseSteps.map((s, i) => ({
                  ...s,
                  order: combo.length + 1 + i,
                })),
              ];

              allFlows.push({
                id: flowId,
                name,
                description: `${asset.symbol} (${groupName}): ${comboDesc}`,
                pageId,
                steps,
                requiresFundedWallet: true,
                category: 'trading',
                priority: 2,
                tested: false,
                testResult: 'untested',
              });
            }
          }
        }

        // ── 6. Generate constraint-based edge cases per asset group ──
        for (const constraint of kg.constraints) {
          for (const [groupName, assets] of assetGroups) {
            const representative = assets[0];
            if (!representative) continue;

            allEdgeCases.push({
              id: `edgecase:computed:${edgeCaseCounter++}`,
              flowId: '',
              name: `${constraint.name} boundary: ${representative.symbol} (${groupName})`,
              description: `${constraint.testImplication} — test on ${representative.symbol}`,
              inputValue: constraint.value,
              expectedBehavior: `System enforces ${constraint.name} = ${constraint.value}`,
              tested: false,
              testResult: 'untested',
            });
          }
        }
      } else {
        // No assets — just cross dimensions
        const combos = crossProduct(dimensions);
        console.log(`  Combos: ${combos.length} (no asset dimension)`);

        for (const combo of combos) {
          const flowId = `flow:computed:${flowCounter++}`;
          const comboDesc = combo.map(c => c.value).join(', ');

          const steps: KGFlowStep[] = [
            ...combo.map((c, i) => ({
              order: i,
              description: `Set ${c.dimension} to "${c.value}"`,
              expectedOutcome: `${c.dimension} set to ${c.value}`,
              selector: c.selector,
            })),
            ...baseSteps.map((s, i) => ({
              ...s,
              order: combo.length + i,
            })),
          ];

          allFlows.push({
            id: flowId,
            name: `${pageName}: ${comboDesc}`,
            description: comboDesc,
            pageId,
            steps,
            requiresFundedWallet: false,
            category: categorizeFromPage(pageName),
            priority: 2,
            tested: false,
            testResult: 'untested',
          });
        }
      }
    }

    // Add reveal flows as-is (navigation flows, modal flows)
    for (const rf of revealFlows) {
      allFlows.push({
        id: `flow:computed:reveal:${flowCounter++}`,
        name: rf.name,
        description: `Navigation/reveal flow: ${rf.path.map(n => n.label).join(' → ')}`,
        pageId: rf.path[0]?.pageId || '',
        steps: rf.path.map((n, i) => ({
          order: i,
          description: `Interact with ${n.role || n.type}: "${n.label}"`,
          expectedOutcome: i < rf.path.length - 1 ? 'Next step revealed' : 'Flow complete',
          selector: n.selector,
        })),
        requiresFundedWallet: rf.requiresFundedWallet,
        category: 'navigation',
        priority: 3,
        tested: false,
        testResult: 'untested',
      });
    }

    console.log(`[FlowComputer] Generated ${allFlows.length} flows, ${allEdgeCases.length} edge cases`);

    // Summarize by category
    const byCat = allFlows.reduce((acc, f) => {
      acc[f.category] = (acc[f.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    for (const [cat, count] of Object.entries(byCat)) {
      console.log(`  ${cat}: ${count} flows`);
    }

    // Persist
    writeFileSync(join(config.outputDir, 'computed-all-flows.json'), JSON.stringify(allFlows, null, 2));
    writeFileSync(join(config.outputDir, 'computed-edge-cases.json'), JSON.stringify(allEdgeCases, null, 2));

    return {
      knowledgeGraph: {
        pages: [], components: [], actions: [],
        flows: allFlows,
        edgeCases: allEdgeCases,
        testCases: [], edges: [],
        features: [], assets: [], dropdownOptions: [], docSections: [], apiEndpoints: [], constraints: [],
      },
    };
  };
}

// ── Helpers ──

interface ComboItem {
  dimension: string;
  value: string;
  selector: string;
}

function crossProduct(dimensions: { name: string; options: string[]; selectors: string[] }[]): ComboItem[][] {
  if (dimensions.length === 0) return [[]];

  const [first, ...rest] = dimensions;
  const restCombos = crossProduct(rest);

  const result: ComboItem[][] = [];
  for (let i = 0; i < first.options.length; i++) {
    for (const restCombo of restCombos) {
      result.push([
        { dimension: first.name, value: first.options[i], selector: first.selectors[i] || '' },
        ...restCombo,
      ]);
    }
  }
  return result;
}

function detectButtonPairs(buttons: { name: string; selector: string; id: string }[]): [typeof buttons[0], typeof buttons[0]][] {
  const pairs: [typeof buttons[0], typeof buttons[0]][] = [];
  const names = buttons.map(b => b.name.toLowerCase());

  // Generic opposing pair detection:
  // Two buttons with short names (< 15 chars) that are antonyms or common DeFi pairs
  const antonyms: [string, string][] = [
    ['long', 'short'],
    ['buy', 'sell'],
    ['deposit', 'withdraw'],
    ['stake', 'unstake'],
    ['lend', 'borrow'],
    ['supply', 'borrow'],
    ['yes', 'no'],
    ['call', 'put'],
    ['up', 'down'],
    ['bid', 'ask'],
  ];

  for (const [a, b] of antonyms) {
    const idxA = names.indexOf(a);
    const idxB = names.indexOf(b);
    if (idxA >= 0 && idxB >= 0) {
      pairs.push([buttons[idxA], buttons[idxB]]);
    }
  }

  return pairs;
}

function buildBaseSteps(formFlow: ComputedFlow, kg: any): KGFlowStep[] {
  // Extract the non-permutation steps: fill inputs, adjust slider, submit
  // Skip nodes that are already handled as dimension permutations (dropdowns, switches)
  const permutationLabels = new Set(
    (formFlow.permutations || []).map(p => p.field)
  );

  const steps: KGFlowStep[] = [];
  let order = 0;

  for (const node of formFlow.path) {
    // Skip nodes handled by dimensions/permutations
    if (permutationLabels.has(node.label)) continue;
    if (node.role === 'switch') continue; // switches are dimensions
    if (node.type === 'form') continue;

    if (node.role === 'spinbutton' || node.role === 'textbox') {
      steps.push({
        order: order++,
        description: `Fill ${node.label} with a valid value`,
        expectedOutcome: `${node.label} value set`,
        selector: node.selector,
      });
    } else if (node.role === 'slider') {
      steps.push({
        order: order++,
        description: `Adjust ${node.label}`,
        expectedOutcome: `${node.label} adjusted`,
        selector: node.selector,
      });
    } else if (!node.role || node.role === 'button') {
      // Skip value buttons (percentage buttons handled separately)
      if (!/^\d+%$/.test(node.label)) {
        steps.push({
          order: order++,
          description: `Click ${node.label}`,
          expectedOutcome: 'Action executed',
          selector: node.selector,
        });
      }
    }
  }

  return steps;
}

function categorizeFromPage(pageName: string): string {
  const n = pageName.toLowerCase();
  if (/trade|swap|exchange/i.test(n)) return 'trading';
  if (/portfolio|position|dashboard/i.test(n)) return 'portfolio';
  if (/earn|vault|stake|farm|pool|lp/i.test(n)) return 'earn';
  if (/referral|invite/i.test(n)) return 'referral';
  return 'navigation';
}

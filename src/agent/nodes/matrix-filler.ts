import { writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, TestPlan, KnowledgeGraph } from '../state.js';
import { DAppGraph, type GraphNode, type ComputedFlow } from '../state.js';

/**
 * Matrix Filler — supplements the planner's intelligent tests with
 * deterministic combinatorial coverage from the graph.
 *
 * Fully generic — no dApp-specific logic. Reads whatever the KG has
 * (assets, dropdowns, switches, constraints, edge cases) and generates
 * the cross-product.
 */
export function createMatrixFillerNode() {
  return async (state: AgentStateType) => {
    const { config, testPlan, knowledgeGraph: kg } = state;

    if (!testPlan) {
      console.warn('[MatrixFiller] No test plan — skipping');
      return {};
    }

    console.log('━━━ Matrix Filler: Filling coverage gaps ━━━');

    const graph = DAppGraph.deserialize(state.graph);
    const existingTestNames = new Set(
      testPlan.suites.flatMap(s => s.tests.map(t => t.name.toLowerCase()))
    );
    const allTestText = testPlan.suites
      .flatMap(s => s.tests.map(t => (t.name + ' ' + t.steps.join(' ')).toLowerCase()))
      .join(' ');

    // Find the main suite (most tests = most complex page)
    const mainSuite = testPlan.suites.reduce((best, s) =>
      s.tests.length > (best?.tests.length || 0) ? s : best
    , testPlan.suites[0]);

    let addedCount = 0;

    // ── 1. Build variation dimensions from KG (generic) ──

    // Dropdown variations: each dropdown component → its options
    const dropdownDimensions: { name: string; options: string[] }[] = [];
    const seenDropdowns = new Map<string, string[]>();
    for (const opt of kg.dropdownOptions) {
      if (!seenDropdowns.has(opt.componentId)) seenDropdowns.set(opt.componentId, []);
      seenDropdowns.get(opt.componentId)!.push(opt.value);
    }
    for (const [compId, opts] of seenDropdowns) {
      if (opts.length > 1) {
        const comp = kg.components.find(c => c.id === compId);
        dropdownDimensions.push({ name: comp?.name || compId, options: opts });
      }
    }

    // Switch variations: each switch → on/off
    const switchDimensions: { name: string; options: string[] }[] = [];
    for (const comp of kg.components) {
      if (comp.role === 'switch') {
        switchDimensions.push({ name: comp.name || comp.id, options: ['on', 'off'] });
      }
    }

    const allDimensions = [...dropdownDimensions, ...switchDimensions];
    console.log(`[MatrixFiller] Dimensions: ${dropdownDimensions.length} dropdowns, ${switchDimensions.length} switches`);

    // ── 2. Cross-product: every asset × every dimension combination ──
    if (kg.assets.length > 0 && mainSuite) {
      const groups = new Map<string, typeof kg.assets>();
      for (const a of kg.assets) {
        if (!groups.has(a.group)) groups.set(a.group, []);
        groups.get(a.group)!.push(a);
      }

      // Generate all dimension combinations
      const combos = allDimensions.length > 0
        ? generateCombinations(allDimensions.map(d => ({ field: d.name, options: d.options })))
        : [[]] as { field: string; value: string }[][];

      console.log(`[MatrixFiller] ${kg.assets.length} assets × ${combos.length} setting combinations = ${kg.assets.length * combos.length} potential tests`);

      for (const [group, groupAssets] of groups) {
        for (const asset of groupAssets) {
          for (const combo of combos) {
            const comboDesc = combo.length > 0
              ? combo.map(c => c.value).join(', ')
              : 'default';

            // Check if already covered
            const isCovered = combo.length > 0
              ? allTestText.includes(asset.symbol.toLowerCase()) &&
                combo.every(c => allTestText.includes(c.value.toLowerCase()))
              : allTestText.includes(asset.symbol.toLowerCase());
            if (isCovered) continue;

            const testName = `${asset.symbol} (${group}) with ${comboDesc}`;
            if (existingTestNames.has(testName.toLowerCase())) continue;

            const groupConstraints = kg.constraints.filter(c =>
              c.scope?.toLowerCase() === group.toLowerCase() || c.scope === 'all'
            );

            // Build steps
            const steps: string[] = [];
            let stepNum = 1;

            steps.push(`Step ${stepNum++}: Select ${asset.symbol} from asset selector (${group} category)`);

            for (const c of combo) {
              if (c.value === 'on' || c.value === 'off') {
                steps.push(`Step ${stepNum++}: ${c.value === 'on' ? 'Enable' : 'Disable'} "${c.field}" switch`);
              } else {
                steps.push(`Step ${stepNum++}: Select "${c.value}" from "${c.field}" dropdown`);
              }
            }

            steps.push(`Step ${stepNum++}: Fill required input fields with valid values`);

            if (asset.maxLeverage) {
              steps.push(`Step ${stepNum++}: Verify max leverage for ${group} is ${asset.maxLeverage}x`);
            }
            for (const gc of groupConstraints.slice(0, 2)) {
              steps.push(`Step ${stepNum++}: Verify constraint: ${gc.name} = ${gc.value}`);
            }

            steps.push(`Step ${stepNum++}: Submit the form`);
            steps.push(`Step ${stepNum++}: Verify action completed for ${asset.symbol} with ${comboDesc}`);

            mainSuite.tests.push({
              id: `matrix-${addedCount}`,
              name: testName,
              steps,
              expectedOutcome: `Action on ${asset.symbol} (${group}) with ${comboDesc}${asset.maxLeverage ? ` — max ${asset.maxLeverage}x` : ''}`,
              requiresFundedWallet: true,
              priority: 2,
            });
            addedCount++;
          }
        }
      }
    }

    // ── 3. Constraint boundary tests ──
    for (const constraint of kg.constraints) {
      const testName = `Boundary: ${constraint.name} = ${constraint.value}${constraint.scope !== 'all' ? ` (${constraint.scope})` : ''}`;
      if (existingTestNames.has(testName.toLowerCase())) continue;

      const alreadyTested = testPlan.suites.some(s =>
        s.tests.some(t => {
          const tLower = (t.name + ' ' + t.expectedOutcome).toLowerCase();
          return tLower.includes(constraint.name.toLowerCase()) &&
            tLower.includes(constraint.value.toLowerCase());
        })
      );
      if (alreadyTested) continue;

      const suite = testPlan.suites[0];
      if (!suite) continue;

      suite.tests.push({
        id: `matrix-constraint-${addedCount}`,
        name: testName,
        steps: [
          `Step 1: Configure form to test ${constraint.name}`,
          `Step 2: Set value to ${constraint.value} (at limit — should succeed)`,
          `Step 3: Verify form accepts the value`,
          `Step 4: Set value above ${constraint.value} (over limit — should fail)`,
          `Step 5: Verify error or rejection`,
        ],
        expectedOutcome: constraint.testImplication,
        requiresFundedWallet: false,
        priority: 2,
      });
      addedCount++;
    }

    // ── 4. Explorer edge cases ──
    for (const ec of kg.edgeCases) {
      const testName = `Edge case: ${ec.name}`;
      if (existingTestNames.has(testName.toLowerCase())) continue;

      const alreadyTested = testPlan.suites.some(s =>
        s.tests.some(t => t.name.toLowerCase().includes(ec.name.toLowerCase().slice(0, 30)))
      );
      if (alreadyTested) continue;

      const suite = testPlan.suites[0];
      if (!suite) continue;

      suite.tests.push({
        id: `matrix-edge-${addedCount}`,
        name: testName,
        steps: [
          `Step 1: ${ec.description}`,
          ec.inputValue ? `Step 2: Enter value "${ec.inputValue}"` : 'Step 2: Trigger the edge case condition',
          `Step 3: Verify behavior: ${ec.expectedBehavior}`,
        ],
        expectedOutcome: ec.expectedBehavior,
        requiresFundedWallet: false,
        priority: 3,
      });
      addedCount++;
    }

    // ── Summary ──
    console.log(`[MatrixFiller] Added ${addedCount} gap-filling tests`);
    const totalTests = testPlan.suites.reduce((s, suite) => s + suite.tests.length, 0);
    console.log(`[MatrixFiller] Total: ${testPlan.suites.length} suites, ${totalTests} tests`);
    testPlan.suites.forEach(s => console.log(`  ${s.name}: ${s.tests.length} tests`));

    // Asset coverage
    if (kg.assets.length > 0) {
      const groups = new Map<string, number>();
      const covered = new Map<string, number>();
      for (const a of kg.assets) {
        groups.set(a.group, (groups.get(a.group) || 0) + 1);
      }
      const finalText = testPlan.suites.flatMap(s => s.tests.map(t => t.name.toLowerCase())).join(' ');
      for (const a of kg.assets) {
        if (finalText.includes(a.symbol.toLowerCase())) {
          covered.set(a.group, (covered.get(a.group) || 0) + 1);
        }
      }
      console.log('[MatrixFiller] Asset coverage:');
      for (const [group, total] of groups) {
        console.log(`  ${group}: ${covered.get(group) || 0}/${total}`);
      }
    }

    writeFileSync(join(config.outputDir, 'test-plan-filled.json'), JSON.stringify(testPlan, null, 2));
    return { testPlan };
  };
}

/** Generate all combinations of option values */
function generateCombinations(
  dimensions: { field: string; options: string[] }[]
): { field: string; value: string }[][] {
  if (dimensions.length === 0) return [[]];
  const [first, ...rest] = dimensions;
  const restCombos = generateCombinations(rest);
  return first.options.flatMap(value =>
    restCombos.map(combo => [{ field: first.field, value }, ...combo])
  );
}

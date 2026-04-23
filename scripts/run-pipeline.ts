#!/usr/bin/env npx tsx
/**
 * E2E pipeline runner for the LangGraph pipeline.
 * Supports skip flags to reuse cached data and avoid wasting credits.
 *
 * Usage:
 *   npx tsx scripts/run-pipeline.ts --url https://developer.avantisfi.com [flags]
 *
 * Flags:
 *   --skip-crawler     Use cached crawl data (no browser needed)
 *   --skip-explorer    Use cached explorer data (no browser/LLM needed)
 *   --skip-planner     Use cached test-plan.json (no LLM needed)
 *   --skip-to <phase>  Skip everything before this phase (crawler|kg_builder|context_builder|explorer|planner|matrix_filler)
 *   --stop-after <phase>  Stop after this phase
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Parse args
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const url = getArg('url') || 'https://developer.avantisfi.com';
const skipCrawler = hasFlag('skip-crawler');
const skipExplorer = hasFlag('skip-explorer');
const skipPlanner = hasFlag('skip-planner');
const skipTo = getArg('skip-to');
const stopAfter = getArg('stop-after');

const seedPhrase = process.env.SEED_PHRASE || '';
const apiKey = process.env.OPENROUTER_API_KEY || '';

const dappName = new URL(url).hostname.replace(/\./g, '-');
const outputDir = join(process.cwd(), 'output', dappName);
mkdirSync(join(outputDir, 'screenshots'), { recursive: true });

console.log('╔══════════════════════════════════════════╗');
console.log('║   LangGraph Pipeline Runner              ║');
console.log('╠══════════════════════════════════════════╣');
console.log(`║  URL:    ${url.slice(0, 32).padEnd(32)}║`);
console.log(`║  Output: ${outputDir.slice(-32).padEnd(32)}║`);
console.log(`║  Skip:   ${[skipCrawler && 'crawler', skipExplorer && 'explorer', skipPlanner && 'planner'].filter(Boolean).join(', ') || 'none'}${' '.repeat(Math.max(0, 32 - ([skipCrawler && 'crawler', skipExplorer && 'explorer', skipPlanner && 'planner'].filter(Boolean).join(', ') || 'none').length))}║`);
console.log('╚══════════════════════════════════════════╝\n');

// Determine which phases to skip based on --skip-to
const phases = ['crawler', 'kg_builder', 'flow_computer', 'flow_validator', 'context_builder', 'explorer', 'planner', 'matrix_filler', 'spec_generator', 'test_runner'];
const skipToIdx = skipTo ? phases.indexOf(skipTo) : -1;
const skipExplorerFlag = hasFlag('skip-explorer');
const skipValidatorFlag = hasFlag('skip-validator');
const skipTestRunnerFlag = hasFlag('skip-test-runner') || stopAfter === 'spec_generator';

async function main() {
  // Import node creators
  const { createCrawlerNode } = await import('../src/agent/nodes/crawler.js');
  const { createKGBuilderNode } = await import('../src/agent/nodes/kg-builder.js');
  const { createFlowComputerNode } = await import('../src/agent/nodes/flow-computer.js');
  const { createFlowValidatorNode } = await import('../src/agent/nodes/flow-validator.js');
  const { createContextBuilderNode } = await import('../src/agent/nodes/context-builder.js');
  const { createExplorerNode } = await import('../src/agent/nodes/explorer.js');
  const { createPlannerNode } = await import('../src/agent/nodes/planner.js');
  const { createMatrixFillerNode } = await import('../src/agent/nodes/matrix-filler.js');
  const { createSpecGeneratorNode } = await import('../src/agent/nodes/spec-generator.js');
  const { createTestRunnerNode } = await import('../src/agent/nodes/test-runner.js');
  const { emptyKnowledgeGraph, DAppGraph } = await import('../src/agent/state.js');

  const config = {
    url,
    seedPhrase,
    apiKey,
    outputDir,
    headless: false,
    explorerModel: 'deepseek/deepseek-chat-v3-0324',
    plannerModel: 'deepseek/deepseek-chat-v3-0324',
    generatorModel: 'qwen/qwen3-coder',
    healerModel: 'qwen/qwen3-coder',
  };

  // Accumulate state as we go (simulates LangGraph state merging)
  let kg = emptyKnowledgeGraph();
  let graphData = { nodes: [] as any[], edges: [] as any[] };
  let crawlData: any = null;
  let testPlan: any = null;

  // Helper to merge KG (same logic as state reducer)
  function mergeKG(update: any) {
    const mergeById = <T extends { id: string }>(a: T[], b: T[]): T[] => {
      const map = new Map(a.map(x => [x.id, x]));
      for (const item of b) map.set(item.id, item);
      return [...map.values()];
    };
    kg = {
      pages: mergeById(kg.pages, update.pages || []),
      components: mergeById(kg.components, update.components || []),
      actions: mergeById(kg.actions, update.actions || []),
      flows: mergeById(kg.flows, update.flows || []),
      edgeCases: mergeById(kg.edgeCases, update.edgeCases || []),
      testCases: mergeById(kg.testCases, update.testCases || []),
      features: mergeById(kg.features, update.features || []),
      assets: mergeById(kg.assets, update.assets || []),
      dropdownOptions: mergeById(kg.dropdownOptions, update.dropdownOptions || []),
      docSections: mergeById(kg.docSections, update.docSections || []),
      apiEndpoints: mergeById(kg.apiEndpoints, update.apiEndpoints || []),
      constraints: mergeById(kg.constraints, update.constraints || []),
      edges: [...kg.edges, ...(update.edges || []).filter((e: any) =>
        !kg.edges.some((x: any) => x.from === e.from && x.to === e.to && x.relationship === e.relationship)
      )],
    };
  }

  function mergeGraph(update: any) {
    const g = DAppGraph.deserialize(graphData);
    for (const n of update.nodes || []) g.addNode(n);
    for (const e of update.edges || []) g.addEdge(e);
    graphData = g.serialize();
  }

  function shouldRun(phase: string): boolean {
    if (skipToIdx >= 0 && phases.indexOf(phase) < skipToIdx) return false;
    if (phase === 'crawler' && skipCrawler) return false;
    if (phase === 'explorer' && (skipExplorer || skipExplorerFlag)) return false;
    if (phase === 'flow_validator' && skipValidatorFlag) return false;
    if (phase === 'planner' && skipPlanner) return false;
    if (phase === 'test_runner' && skipTestRunnerFlag) return false;
    return true;
  }

  function shouldStop(phase: string): boolean {
    return stopAfter === phase;
  }

  function buildState() {
    return {
      messages: [],
      knowledgeGraph: kg,
      graph: graphData,
      crawlData,
      testPlan,
      specFiles: [],
      testResults: [],
      iteration: 0,
      maxIterations: 3,
      config,
    } as any;
  }

  // ── Browser setup (only if needed) ──
  // The crawler's node still invokes its cache-reader even when skipped, which calls
  // page.goto(...). To tolerate that with a dummy browser, we only skip the real
  // launch when NO phase actually needs a live page — i.e., crawler has cached data
  // AND every other phase that normally uses the browser is skipped.
  let browserCtx: any = null;
  const needsBrowser = (shouldRun('crawler') && !existsSync(join(outputDir, 'scraped-data.json'))) ||
                        shouldRun('flow_validator') ||
                        shouldRun('explorer') ||
                        shouldRun('test_runner');

  if (needsBrowser) {
    console.log('[Pipeline] Launching browser...');
    const { launchBrowser } = await import('../src/browser/launcher.js');
    browserCtx = await launchBrowser({
      seedPhrase,
      headless: false,
      screenshotDir: join(outputDir, 'screenshots'),
    });
  } else {
    // Dummy browser ctx for crawler cache loading (it won't actually use the browser)
    browserCtx = {
      page: { goto: async () => {}, waitForTimeout: async () => {}, url: () => url },
      context: {},
      snapshotRefs: new Map(),
      screenshotDir: join(outputDir, 'screenshots'),
      screenshotCounter: 0,
    };
  }

  try {
    // ── 1. CRAWLER ──
    if (shouldRun('crawler')) {
      console.log('\n━━━ Phase 1: Crawler ━━━');
      const node = createCrawlerNode(browserCtx);
      const result = await node(buildState());
      if (result.knowledgeGraph) mergeKG(result.knowledgeGraph);
      if (result.crawlData) crawlData = result.crawlData;
      console.log(`[Crawler] KG: ${kg.pages.length} pages, ${kg.components.length} components, ${kg.assets.length} assets`);
    } else {
      console.log('\n━━━ Phase 1: Crawler (CACHED) ━━━');
      // Still need to build KG from cached data
      const node = createCrawlerNode(browserCtx);
      const result = await node(buildState());
      if (result.knowledgeGraph) mergeKG(result.knowledgeGraph);
      if (result.crawlData) crawlData = result.crawlData;
      console.log(`[Crawler] Loaded cached KG: ${kg.pages.length} pages, ${kg.components.length} components, ${kg.assets.length} assets`);
    }
    if (shouldStop('crawler')) { printSummary(); return; }

    // ── 2. KG BUILDER ──
    if (shouldRun('kg_builder')) {
      console.log('\n━━━ Phase 2: KG Builder ━━━');
      const node = createKGBuilderNode();
      const result = await node(buildState());
      if (result.graph) mergeGraph(result.graph);
      const g = DAppGraph.deserialize(graphData);
      console.log(`[KG Builder] Graph: ${g.stats.nodes} nodes, ${g.stats.edges} edges`);
    }
    if (shouldStop('kg_builder')) { printSummary(); return; }

    // ── 2b. FLOW COMPUTER ──
    if (shouldRun('flow_computer')) {
      console.log('\n━━━ Phase 2b: Flow Computer ━━━');
      const node = createFlowComputerNode();
      const result = await node(buildState());
      if (result.knowledgeGraph) mergeKG(result.knowledgeGraph);
      console.log(`[FlowComputer] KG now has ${kg.flows.length} flows, ${kg.edgeCases.length} edge cases`);
    }
    if (shouldStop('flow_computer')) { printSummary(); return; }

    // ── 2c. FLOW VALIDATOR ──
    if (shouldRun('flow_validator')) {
      console.log('\n━━━ Phase 2c: Flow Validator ━━━');
      const node = createFlowValidatorNode(browserCtx);
      const result = await node(buildState());
      if (result.knowledgeGraph) mergeKG(result.knowledgeGraph);
      console.log(`[FlowValidator] KG now has ${kg.flows.length} flows, ${kg.constraints.length} constraints`);
    }
    if (shouldStop('flow_validator')) { printSummary(); return; }

    // ── 3. CONTEXT BUILDER ──
    if (shouldRun('context_builder')) {
      console.log('\n━━━ Phase 3: Context Builder ━━━');
      const node = createContextBuilderNode();
      const result = await node(buildState());
      if (result.crawlData) crawlData = { ...crawlData, ...result.crawlData };
    }
    if (shouldStop('context_builder')) { printSummary(); return; }

    // ── 4. EXPLORER ──
    if (shouldRun('explorer')) {
      console.log('\n━━━ Phase 4: Explorer ━━━');
      const node = createExplorerNode(browserCtx);
      const result = await node(buildState());
      if (result.knowledgeGraph) mergeKG(result.knowledgeGraph);
    } else {
      console.log('\n━━━ Phase 4: Explorer (SKIPPED) ━━━');
      // Load cached explorer findings if available
      const findingsPath = join(outputDir, 'explorer-kg-update.json');
      if (existsSync(findingsPath)) {
        const findings = JSON.parse(readFileSync(findingsPath, 'utf-8'));
        mergeKG(findings);
        console.log(`[Explorer] Loaded cached findings: ${findings.flows?.length || 0} flows, ${findings.edgeCases?.length || 0} edge cases`);
      }
    }
    if (shouldStop('explorer')) { printSummary(); return; }

    // ── 5. PLANNER ──
    if (shouldRun('planner')) {
      console.log('\n━━━ Phase 5: Planner ━━━');
      const node = createPlannerNode();
      const result = await node(buildState());
      if (result.testPlan) testPlan = result.testPlan;
      if (result.knowledgeGraph) mergeKG(result.knowledgeGraph);
      const testCount = testPlan?.suites?.reduce((s: number, suite: any) => s + suite.tests.length, 0) || 0;
      console.log(`[Planner] ${testPlan?.suites?.length || 0} suites, ${testCount} tests`);
    } else {
      console.log('\n━━━ Phase 5: Planner (CACHED) ━━━');
      const planPath = join(outputDir, 'test-plan.json');
      if (existsSync(planPath)) {
        testPlan = JSON.parse(readFileSync(planPath, 'utf-8'));
        const testCount = testPlan.suites.reduce((s: number, suite: any) => s + suite.tests.length, 0);
        console.log(`[Planner] Loaded cached plan: ${testPlan.suites.length} suites, ${testCount} tests`);
      } else {
        console.error('[Planner] No cached test plan found! Cannot skip planner without test-plan.json');
        process.exit(1);
      }
    }
    if (shouldStop('planner')) { printSummary(); return; }

    // ── 6. MATRIX FILLER ──
    if (shouldRun('matrix_filler')) {
      console.log('\n━━━ Phase 6: Matrix Filler ━━━');
      const node = createMatrixFillerNode();
      const result = await node(buildState());
      if (result.testPlan) testPlan = result.testPlan;
    }
    if (shouldStop('matrix_filler')) { printSummary(); return; }

    // ── 7a. SPEC GENERATOR ──
    // Split from test_runner so callers can generate specs without executing them
    // (which lets us skip the browser-dependent test_runner entirely via --stop-after spec_generator).
    let specFilesArr: string[] = [];
    if (shouldRun('spec_generator') || shouldRun('test_runner')) {
      console.log('\n━━━ Phase 7a: Spec Generator ━━━');
      const specNode = createSpecGeneratorNode();
      const specResult = await specNode(buildState());
      if (specResult.specFiles) specFilesArr = specResult.specFiles;
      console.log(`[SpecGen] wrote ${specFilesArr.length} spec file(s)`);
    }
    if (shouldStop('spec_generator')) { printSummary(); return; }

    // ── 7b. TEST RUNNER (execute + heal) ──
    if (shouldRun('test_runner') && specFilesArr.length > 0) {
      console.log('\n━━━ Phase 7b: Test Runner (Execute + Heal) ━━━');
      // Inject spec files into state
      const runnerState = { ...buildState(), specFiles: specFilesArr };
      const node = createTestRunnerNode(browserCtx);
      const result = await node(runnerState as any);
      if (result.testResults) {
        const passed = result.testResults.filter((r: any) => r.status === 'passed').length;
        const failed = result.testResults.filter((r: any) => r.status === 'failed').length;
        console.log(`[TestRunner] Final: ${passed} passed, ${failed} failed out of ${result.testResults.length}`);
      }
    }
    if (shouldStop('test_runner')) { printSummary(); return; }

    printSummary();

  } finally {
    if (needsBrowser && browserCtx?.context?.close) {
      const { closeBrowser } = await import('../src/browser/launcher.js');
      await closeBrowser(browserCtx).catch(() => {});
    }
  }

  function printSummary() {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║   Pipeline Complete                      ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  KG: ${kg.pages.length} pages, ${kg.components.length} components`.padEnd(43) + '║');
    console.log(`║  Assets: ${kg.assets.length}, Constraints: ${kg.constraints.length}`.padEnd(43) + '║');
    console.log(`║  Flows: ${kg.flows.length}, Edge cases: ${kg.edgeCases.length}`.padEnd(43) + '║');
    const g = DAppGraph.deserialize(graphData);
    console.log(`║  Graph: ${g.stats.nodes} nodes, ${g.stats.edges} edges`.padEnd(43) + '║');
    if (testPlan) {
      const totalTests = testPlan.suites.reduce((s: number, suite: any) => s + suite.tests.length, 0);
      console.log(`║  Test plan: ${testPlan.suites.length} suites, ${totalTests} tests`.padEnd(43) + '║');
      for (const s of testPlan.suites) {
        console.log(`║    ${s.name}: ${s.tests.length} tests`.padEnd(43) + '║');
      }
      // Check for unnamed element issues
      const unnamed = testPlan.suites.flatMap((s: any) => s.tests).filter((t: any) =>
        t.name.includes('unnamed') || t.steps?.some((st: string) => st.includes('unnamed'))
      );
      if (unnamed.length > 0) {
        console.log(`║  ⚠ ${unnamed.length} tests reference unnamed elements`.padEnd(43) + '║');
      }
    }
    console.log('╚══════════════════════════════════════════╝');

    // Persist final KG
    writeFileSync(join(outputDir, 'knowledge-graph.json'), JSON.stringify(kg, null, 2));
    writeFileSync(join(outputDir, 'graph-final.json'), JSON.stringify(graphData, null, 2));
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  console.error(e.stack);
  process.exit(1);
});

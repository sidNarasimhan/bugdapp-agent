import { StateGraph, END, START } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { AgentState, type AgentStateType } from './state.js';
import { createCrawlerNode } from './nodes/crawler.js';
import { createKGBuilderNode } from './nodes/kg-builder.js';
import { createContextBuilderNode } from './nodes/context-builder.js';
import { createExplorerNode } from './nodes/explorer.js';
import { createPlannerNode } from './nodes/planner.js';
import { createMatrixFillerNode } from './nodes/matrix-filler.js';
import { createGeneratorNode } from './nodes/generator.js';
import { createExecutorNode } from './nodes/executor.js';
import { createHealerNode } from './nodes/healer.js';
import type { BrowserCtx } from '../types.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Build the full QA agent graph:
 *
 *   crawler → explorer → planner → generator → executor → [conditional]
 *                                                              ↓
 *                                                     coverage OK? → END
 *                                                     coverage bad? → healer → [conditional]
 *                                                                                ↓
 *                                                                       retries left? → explorer
 *                                                                       max retries? → END
 */
export async function buildQAGraph(browserCtx: BrowserCtx, outputDir: string) {
  const graph = new StateGraph(AgentState)
    .addNode('crawler', createCrawlerNode(browserCtx))
    .addNode('kg_builder', createKGBuilderNode())
    .addNode('context_builder', createContextBuilderNode())
    .addNode('explorer', createExplorerNode(browserCtx))
    .addNode('planner', createPlannerNode())
    .addNode('matrix_filler', createMatrixFillerNode())
    .addNode('generator', createGeneratorNode())
    .addNode('executor', createExecutorNode())
    .addNode('healer', createHealerNode())
    .addNode('report', createReportNode())

    // Linear flow: crawler → explorer → planner → generator → executor
    .addEdge(START, 'crawler')
    .addEdge('crawler', 'kg_builder')
    .addEdge('kg_builder', 'context_builder')
    .addEdge('context_builder', 'explorer')
    .addEdge('explorer', 'planner')
    .addEdge('planner', 'matrix_filler')
    .addEdge('matrix_filler', 'generator')
    .addEdge('generator', 'executor')

    // After executor: check coverage
    .addConditionalEdges('executor', shouldHeal, {
      heal: 'healer',
      done: 'report',
    })

    // After healer: loop back or finish
    .addConditionalEdges('healer', shouldRetry, {
      retry: 'generator',
      done: 'report',
    })

    .addEdge('report', END);

  // TODO: re-enable checkpointing after debugging
  // const checkpointer = SqliteSaver.fromConnString(join(outputDir, 'checkpoints.db'));
  return graph.compile();
}

function shouldHeal(state: AgentStateType): 'heal' | 'done' {
  const results = state.testResults;
  if (results.length === 0) {
    console.log('[Orchestrator] No test results — skipping heal');
    return 'done';
  }

  const passed = results.filter(r => r.status === 'passed').length;
  const total = results.length;
  const passRate = passed / total;

  console.log(`[Orchestrator] Pass rate: ${passed}/${total} (${(passRate * 100).toFixed(0)}%)`);

  if (passRate >= 0.8) {
    console.log('[Orchestrator] ≥80% pass rate — done');
    return 'done';
  }

  if (state.iteration >= state.maxIterations) {
    console.log(`[Orchestrator] Max iterations (${state.maxIterations}) reached — done`);
    return 'done';
  }

  console.log('[Orchestrator] Pass rate < 80% — healing');
  return 'heal';
}

function shouldRetry(state: AgentStateType): 'retry' | 'done' {
  const newIteration = state.iteration + 1;
  if (newIteration >= state.maxIterations) {
    console.log(`[Orchestrator] Iteration ${newIteration}/${state.maxIterations} — no more retries`);
    return 'done';
  }
  console.log(`[Orchestrator] Iteration ${newIteration}/${state.maxIterations} — retrying`);
  return 'retry';
}

function createReportNode() {
  return async (state: AgentStateType) => {
    const { config, knowledgeGraph, testResults, testPlan, iteration } = state;

    console.log('━━━ Report: Final Summary ━━━');

    const passed = testResults.filter(r => r.status === 'passed').length;
    const failed = testResults.filter(r => r.status === 'failed').length;
    const total = testResults.length;
    const passRate = total > 0 ? (passed / total * 100).toFixed(1) : '0';

    const kgStats = {
      pages: knowledgeGraph.pages.length,
      components: knowledgeGraph.components.length,
      actions: knowledgeGraph.actions.length,
      flows: knowledgeGraph.flows.length,
      edgeCases: knowledgeGraph.edgeCases.length,
      testCases: knowledgeGraph.testCases.length,
      edges: knowledgeGraph.edges.length,
    };

    const report = {
      dappUrl: config.url,
      timestamp: new Date().toISOString(),
      iterations: iteration,
      knowledgeGraph: kgStats,
      testPlan: {
        suites: testPlan?.suites.length || 0,
        totalTests: testPlan?.suites.reduce((s, suite) => s + suite.tests.length, 0) || 0,
      },
      execution: {
        total,
        passed,
        failed,
        skipped: testResults.filter(r => r.status === 'skipped').length,
        passRate: `${passRate}%`,
      },
      failures: testResults
        .filter(r => r.status === 'failed')
        .map(r => ({ test: r.title, error: r.error?.slice(0, 200) })),
    };

    writeFileSync(join(config.outputDir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(config.outputDir, 'knowledge-graph.json'), JSON.stringify(knowledgeGraph, null, 2));

    console.log('╔══════════════════════════════════════════╗');
    console.log('║       Web3 QA Agent — Report             ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  URL:        ${config.url.substring(0, 28).padEnd(28)} ║`);
    console.log(`║  Tests:      ${String(total).padEnd(28)} ║`);
    console.log(`║  Passed:     ${String(passed).padEnd(28)} ║`);
    console.log(`║  Failed:     ${String(failed).padEnd(28)} ║`);
    console.log(`║  Pass Rate:  ${passRate.padEnd(27)}% ║`);
    console.log(`║  Iterations: ${String(iteration).padEnd(28)} ║`);
    console.log(`║  KG Nodes:   ${String(kgStats.pages + kgStats.components + kgStats.flows).padEnd(28)} ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log(`\nFull report: ${join(config.outputDir, 'report.json')}`);
    console.log(`Knowledge graph: ${join(config.outputDir, 'knowledge-graph.json')}`);

    return { iteration: iteration + 1 };
  };
}

/**
 * Explorer — agent-driven KG enhancement.
 *
 * Runs AFTER the structural crawler and KG-builder, BEFORE comprehension.
 * The crawler collects DOM + network + docs deterministically but misses
 * anything that requires interaction (submit forms, trigger error messages,
 * observe validation states, walk multi-step flows). The explorer closes that
 * gap by running the same executor agent (Claude Sonnet 4.5) in "explore"
 * mode — it drives the browser with an exploration task, observes what
 * happens, and writes the findings back into the KG.
 *
 * Output: output/<host>/exploration.json — structured notes + additional
 *   flows / edge cases / constraints observed at runtime, to be merged into
 *   knowledge-graph.json on the next crawl pass.
 *
 * The explorer shares everything with the executor:
 *   - same Chromium + MetaMask session
 *   - same browser + wallet tool set
 *   - same budget caps (20 iter / 100k tokens / 8 min)
 *   - same knowledge loader (sees current KG + partial comprehension)
 * It differs ONLY in the system prompt's mission.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { runExecutor, type ExecutorResult } from '../agent/loop.js';
import { activeDApp, outputDir as activeOutputDir } from '../config.js';

export interface ExplorationOutput {
  summary: string;
  outcome: ExecutorResult['outcome'];
  observations: Array<{ iteration: number; tool: string; output: string }>;
  durationMs: number;
  tokensUsed: number;
  generatedAt: string;
}

const EXPLORE_TASK = [
  'EXPLORE this dApp to enrich the knowledge graph. Your goal is NOT to complete a trade or take a destructive action — it is to observe what the crawler missed.',
  '',
  'Priorities:',
  '1. For each primary form you find: fill it with realistic values + invalid values. Observe what error messages / validation / state changes appear.',
  '2. Walk multi-step flows end-to-end WITHOUT submitting (never click a final Approve/Submit/Open that would spend funds).',
  '3. Switch between tabs, order types, leverage sliders, asset selectors — note what changes in the UI.',
  '4. Record constraints the UI enforces at runtime (min amounts, max leverage, required fields, market hours warnings).',
  '5. Identify modals, tooltips, and help text that appear during interaction.',
  '',
  'When done, call task_complete with a terse summary of new findings. Do NOT submit transactions.',
].join('\n');

export async function explore(): Promise<ExplorationOutput> {
  const dapp = activeDApp();
  const outDir = activeOutputDir(dapp);
  mkdirSync(outDir, { recursive: true });

  const started = Date.now();
  const result = await runExecutor({ task: EXPLORE_TASK, dapp, initialUrl: dapp.url });
  const observations = result.steps
    .filter(s => s.success && (s.tool === 'browser_snapshot' || s.tool === 'browser_click' || s.tool === 'browser_type' || s.tool.startsWith('wallet_')))
    .map(s => ({ iteration: s.iteration, tool: s.tool, output: s.output.slice(0, 800) }));

  const out: ExplorationOutput = {
    summary: result.summary,
    outcome: result.outcome,
    observations,
    durationMs: Date.now() - started,
    tokensUsed: result.tokensUsed,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, 'exploration.json'), JSON.stringify(out, null, 2));
  return out;
}

/**
 * Explorer — agent-driven KG enrichment, module-by-module.
 *
 * Same agent as the chat/spec-heal executor (`runExecutor`). The only
 * difference is the task given: "explore this module, fill gaps, observe
 * constraints, do NOT submit transactions." One exploration run per module.
 *
 * Input:  output/<host>/modules.json (from module-segmenter) + per-module
 *         .md (from markdown-emitter) so the agent has context before it starts.
 * Output: output/<host>/exploration.json — per-module findings (successful
 *         tool traces + LLM summary) ready to fold back into the KG.
 *
 * Budget per module: same executor caps (20 iter / 100k tok / 8 min). With
 * prompt caching on stable blocks, cost per module ~$0.08-0.15.
 *
 * If modules.json is absent, falls back to one whole-dApp exploration run.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { runExecutor, type ExecutorResult, type ExecutorStep } from '../agent/loop.js';
import { activeDApp, outputDir as activeOutputDir, type ActiveDApp } from '../config.js';
import type { DAppModule } from '../agent/state.js';

export interface ModuleExplorationReport {
  moduleId: string;
  moduleName: string;
  outcome: ExecutorResult['outcome'];
  summary: string;
  observations: Array<{ iteration: number; tool: string; output: string }>;
  durationMs: number;
  tokensUsed: number;
  cacheHitRate: number;
}

export interface ExplorationOutput {
  generatedAt: string;
  dappName: string;
  modulesExplored: number;
  perModule: ModuleExplorationReport[];
  totalDurationMs: number;
  totalTokens: number;
  totalCacheReadTokens: number;
}

function exploreTaskFor(m: DAppModule, moduleMd: string): string {
  return [
    `EXPLORE the "${m.name}" module to enrich the knowledge graph. Do NOT submit transactions.`,
    '',
    'Priorities:',
    '1. Fill every input in this module with realistic AND invalid values. Observe error messages, validation hints, disabled states.',
    '2. Walk any multi-step form sequence up to the submit button — STOP there.',
    '3. Toggle every switch, slider, dropdown, tab belonging to this module. Note what changes.',
    '4. Read runtime-enforced constraints (min/max amounts, required fields, leverage bounds) from the UI.',
    '5. Identify any modal, tooltip, warning, or help text that appears during interaction.',
    '',
    `When done, call task_complete with a terse summary of new findings specific to the "${m.name}" module.`,
    '',
    '# MODULE CONTEXT (load this before interacting)',
    moduleMd,
  ].join('\n');
}

function flattenModules(mods: DAppModule[]): DAppModule[] {
  const out: DAppModule[] = [];
  const walk = (ms: DAppModule[]) => { for (const m of ms) { out.push(m); if (m.subModules?.length) walk(m.subModules); } };
  walk(mods);
  return out;
}

function observationsFrom(steps: ExecutorStep[]) {
  return steps
    .filter(s => s.success && (s.tool === 'browser_snapshot' || s.tool === 'browser_click' || s.tool === 'browser_type' || s.tool.startsWith('wallet_')))
    .map(s => ({ iteration: s.iteration, tool: s.tool, output: s.output.slice(0, 800) }));
}

export async function explore(): Promise<ExplorationOutput> {
  const dapp = activeDApp();
  const outDir = activeOutputDir(dapp);
  mkdirSync(outDir, { recursive: true });

  const modulesPath = join(outDir, 'modules.json');
  const modules: DAppModule[] = existsSync(modulesPath)
    ? flattenModules(JSON.parse(readFileSync(modulesPath, 'utf-8')))
    : [];

  const started = Date.now();
  const perModule: ModuleExplorationReport[] = [];

  if (modules.length === 0) {
    console.log('[explorer] modules.json missing — running single whole-dApp exploration');
    const mdPath = join(outDir, 'knowledge', 'index.md');
    const md = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : '';
    const task = exploreTaskFor({ id: 'module:whole', name: 'whole dApp', pageIds: [], componentIds: [], docSectionIds: [], apiEndpointIds: [], contractAddresses: [], constraintIds: [], triggeredByComponentIds: [], description: '', businessPurpose: '' } as DAppModule, md);
    const r = await runExecutor({ task, dapp });
    perModule.push({
      moduleId: 'module:whole', moduleName: 'whole dApp',
      outcome: r.outcome, summary: r.summary,
      observations: observationsFrom(r.steps),
      durationMs: r.durationMs, tokensUsed: r.tokensUsed,
      cacheHitRate: r.tokensUsed > 0 ? r.cacheReadTokens / r.tokensUsed : 0,
    });
  } else {
    // Skip modules that have too few components to meaningfully explore
    const worth = modules.filter(m => m.componentIds.length >= 3);
    console.log(`[explorer] ${worth.length} modules worth exploring (of ${modules.length} total)`);
    for (const m of worth) {
      const slug = m.id.replace(/^module:/, '').replace(/:/g, '.');
      const mdPath = join(outDir, 'knowledge', `${slug}.md`);
      const md = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : '';
      console.log(`[explorer]   ▶ ${m.name} (${m.componentIds.length} components)`);
      const r = await runExecutor({ task: exploreTaskFor(m, md), dapp });
      perModule.push({
        moduleId: m.id, moduleName: m.name,
        outcome: r.outcome, summary: r.summary,
        observations: observationsFrom(r.steps),
        durationMs: r.durationMs, tokensUsed: r.tokensUsed,
        cacheHitRate: r.tokensUsed > 0 ? r.cacheReadTokens / r.tokensUsed : 0,
      });
      console.log(`[explorer]     ${r.outcome} · ${r.steps.length} steps · ${(r.durationMs/1000).toFixed(1)}s · ${Math.round(r.tokensUsed/1000)}k tok · cache ${(r.cacheReadTokens*100/Math.max(1,r.tokensUsed)).toFixed(0)}%`);
    }
  }

  const out: ExplorationOutput = {
    generatedAt: new Date().toISOString(),
    dappName: dapp.name,
    modulesExplored: perModule.length,
    perModule,
    totalDurationMs: Date.now() - started,
    totalTokens: perModule.reduce((s, r) => s + r.tokensUsed, 0),
    totalCacheReadTokens: 0, // filled by runExecutor's reports if we track per-call
  };
  writeFileSync(join(outDir, 'exploration.json'), JSON.stringify(out, null, 2));
  return out;
}

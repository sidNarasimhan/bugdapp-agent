/**
 * Self-healing suite runner.
 *
 * Phase 1: run Playwright (deterministic, $0 — specs as they are on disk).
 * Phase 2: for every failed test, invoke the executor agent to act-observe and
 *          complete the same task on the live dApp. If the agent succeeds, call
 *          spec-healer to rewrite the test body from the agent's trace — next
 *          run is pure Playwright again.
 * Phase 3: re-run just the healed specs to confirm they pass pure Playwright.
 *
 * Used by `scripts/live.ts --run-suite` and by the chat handler's spec-mode
 * cascade.
 */
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { activeDApp, outputDir as activeOutputDir } from '../config.js';
import { runExecutor } from '../agent/loop.js';
import { healSpec } from './spec-healer.js';

export interface HealRunOptions {
  dAppUrl?: string;
  outputDir?: string;
  /** If true, re-run healed specs under Playwright after healing. Default: true. */
  verifyAfterHeal?: boolean;
  /** If set, run only specs whose filename matches this grep. */
  specFilter?: string;
  onLine?: (line: string) => void;
}

export interface HealRunSummary {
  firstRun: { passed: number; failed: number; total: number };
  healed: { specFile: string; testTitle: string; backupPath?: string; ok: boolean; reason?: string }[];
  unhealed: { specFile: string; testTitle: string; agentOutcome: string; reason?: string }[];
  verifyRun?: { passed: number; failed: number };
  totalDurationMs: number;
}

interface PwTestRef {
  specFile: string;      // e.g. "perps-primary.spec.ts"
  testTitle: string;     // exact title
}

export async function runSuiteWithHealing(opts: HealRunOptions = {}): Promise<HealRunSummary> {
  const started = Date.now();
  const emit = opts.onLine ?? ((l) => console.log(l));
  const dapp = activeDApp();
  const outDir = opts.outputDir ?? activeOutputDir(dapp);

  emit(`[heal-runner] Phase 1: Playwright (as-is)`);
  const r1 = await runPlaywright(outDir, emit, opts.specFilter);
  const failures = extractFailures(r1);
  emit(`[heal-runner] first run: ${r1.passed}/${r1.total} passed, ${r1.failed} failed`);

  const healed: HealRunSummary['healed'] = [];
  const unhealed: HealRunSummary['unhealed'] = [];

  if (failures.length > 0) {
    emit(`[heal-runner] Phase 2: agent recovery + heal for ${failures.length} failure(s)`);

    for (const f of failures) {
      emit(`[heal-runner]   ▶ ${f.specFile} / "${f.testTitle}"`);
      const task = `Reproduce this test on the live dApp: ${f.testTitle}. The existing Playwright spec failed — analyze the page state, complete the flow yourself, and use task_complete when done.`;
      const agent = await runExecutor({ task, dapp, initialUrl: dapp.url });

      if (agent.outcome !== 'complete') {
        emit(`[heal-runner]   ✗ agent ${agent.outcome}: ${agent.summary}`);
        unhealed.push({
          specFile: f.specFile,
          testTitle: f.testTitle,
          agentOutcome: agent.outcome,
          reason: agent.summary,
        });
        continue;
      }

      const specPath = join(outDir, 'tests', f.specFile);
      const heal = await healSpec(specPath, f.testTitle, agent.steps);
      if (heal.ok) {
        emit(`[heal-runner]   ✔ healed ${f.specFile} (${heal.linesInjected} lines)`);
        healed.push({ specFile: f.specFile, testTitle: f.testTitle, backupPath: heal.backupPath, ok: true });
      } else {
        emit(`[heal-runner]   ⚠ heal failed: ${heal.reason}`);
        unhealed.push({
          specFile: f.specFile,
          testTitle: f.testTitle,
          agentOutcome: 'complete-but-heal-failed',
          reason: heal.reason,
        });
      }
    }
  }

  // Phase 3: verify healed specs
  let verifyRun: HealRunSummary['verifyRun'] | undefined;
  if (healed.length > 0 && opts.verifyAfterHeal !== false) {
    const grep = healed.map(h => `tests/${h.specFile}`).join('|');
    emit(`[heal-runner] Phase 3: Playwright re-run of healed specs (${healed.length})`);
    const r2 = await runPlaywright(outDir, emit, grep);
    verifyRun = { passed: r2.passed, failed: r2.failed };
    emit(`[heal-runner] verify: ${r2.passed}/${r2.total} passed, ${r2.failed} failed`);
  }

  return {
    firstRun: { passed: r1.passed, failed: r1.failed, total: r1.total },
    healed,
    unhealed,
    verifyRun,
    totalDurationMs: Date.now() - started,
  };
}

// ---------- Playwright invocation + result parsing ----------

interface PwRunResult {
  total: number; passed: number; failed: number;
  results: any | null;
}

function runPlaywright(outputDir: string, emit: (l: string) => void, filter?: string): Promise<PwRunResult> {
  const args = ['playwright', 'test', '--reporter=json'];
  if (filter) {
    // Treat filter as a path when it looks like one (new module-organized
    // specs), else as a --grep pattern (matches test title substring).
    if (/\.spec\.ts$/.test(filter) || filter.includes('/')) {
      args.push(filter);
    } else {
      args.push(`--grep=${filter}`);
    }
  }

  return new Promise((resolve) => {
    const child = spawn('npx', args, { cwd: outputDir, shell: true });
    let stdout = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      for (const line of s.split('\n')) if (line.trim()) emit(line);
    });
    child.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) if (line.trim()) emit(line);
    });
    child.on('close', () => {
      let results: any = null;
      const resultsPath = join(outputDir, 'results.json');
      if (existsSync(resultsPath)) {
        try { results = JSON.parse(readFileSync(resultsPath, 'utf-8')); } catch {}
      } else {
        // some playwright configs emit to stdout — try to pull it out
        try { results = JSON.parse(stdout); } catch {}
      }
      const counts = summarizeResults(results);
      resolve({ ...counts, results });
    });
  });
}

function summarizeResults(r: any): { total: number; passed: number; failed: number } {
  let total = 0, passed = 0, failed = 0;
  if (!r) return { total, passed, failed };
  const walk = (suite: any) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const res of test.results ?? []) {
          total++;
          if (res.status === 'passed') passed++;
          else if (res.status !== 'skipped') failed++;
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const s of r.suites ?? []) walk(s);
  return { total, passed, failed };
}

function extractFailures(r: PwRunResult): PwTestRef[] {
  const out: PwTestRef[] = [];
  if (!r.results) return out;
  const walk = (suite: any, file: string) => {
    const specFile = suite.file ? basename(suite.file) : file;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const res of test.results ?? []) {
          if (res.status !== 'passed' && res.status !== 'skipped') {
            out.push({ specFile, testTitle: spec.title });
          }
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child, specFile);
  };
  for (const s of r.results.suites ?? []) walk(s, s.file ? basename(s.file) : '');
  return out;
}

export function formatHealSummary(s: HealRunSummary): string {
  const first = `first: ${s.firstRun.passed}/${s.firstRun.total} passed, ${s.firstRun.failed} failed`;
  const healed = s.healed.length > 0 ? `\nhealed (${s.healed.length}):\n${s.healed.map(h => `  ✔ ${h.specFile} — ${h.testTitle}`).join('\n')}` : '';
  const unhealed = s.unhealed.length > 0 ? `\nunhealed (${s.unhealed.length}):\n${s.unhealed.map(h => `  ✗ ${h.specFile} — ${h.testTitle}: ${h.reason ?? h.agentOutcome}`).join('\n')}` : '';
  const verify = s.verifyRun ? `\nverify: ${s.verifyRun.passed} passed, ${s.verifyRun.failed} failed` : '';
  return `${first}${healed}${unhealed}${verify}\nduration: ${(s.totalDurationMs / 1000).toFixed(1)}s`;
}

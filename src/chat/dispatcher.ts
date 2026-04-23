/**
 * Run dispatcher — spawns the live pipeline / test suite for a given dApp,
 * streams stdout to the caller via a progress callback, and returns a
 * summary plus the parsed Playwright results (if a run happened).
 */
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { DAppProfile } from '../agent/profiles/types.js';
import type { SpecFilter } from './commands.js';

export interface RunResult {
  dApp: string;
  url: string;
  filter: SpecFilter;
  exitCode: number;
  durationMs: number;
  outputDir: string;
  results: PlaywrightResults | null;
  summary: TestSummary;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
}

export interface TestFailure {
  file: string;
  title: string;
  error: string;
  screenshot?: string;
  duration: number;
}

export interface PlaywrightResults {
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number };
  suites?: any[];
}

export type ProgressCb = (line: string) => void;

function hostDir(url: string): string {
  try { return new URL(url).hostname.replace(/\./g, '-'); } catch { return url; }
}

function selectSpecGlob(filter: SpecFilter): string | null {
  if (filter === 'all') return null;
  // matches the naming used by comprehension-spec-gen + legacy generator
  const map: Record<string, string> = {
    perps: 'tests/**/{perps,long,short,trade}*.spec.ts',
    swap: 'tests/**/swap*.spec.ts',
    lending: 'tests/**/{lending,supply,borrow}*.spec.ts',
    staking: 'tests/**/{stake,staking}*.spec.ts',
    cdp: 'tests/**/{cdp,vault}*.spec.ts',
    yield: 'tests/**/{yield,farm}*.spec.ts',
    navigation: 'tests/navigation.spec.ts',
    adversarial: 'tests/adversarial.spec.ts',
  };
  return map[filter] ?? null;
}

export async function runDApp(
  dApp: DAppProfile,
  filter: SpecFilter,
  onProgress: ProgressCb,
): Promise<RunResult> {
  const started = Date.now();
  const outputDir = join(process.cwd(), 'output', hostDir(dApp.url));
  const glob = selectSpecGlob(filter);

  // Strategy: use scripts/live.ts for orchestration. It handles caching + run-suite.
  // Skip expensive phases: crawl + comprehend rely on cached artifacts, which exist
  // for the 5 already-crawled dApps. For a fresh dApp the first run will fail; we
  // report that cleanly rather than silently regressing.
  const args = [
    'tsx', 'scripts/live.ts', dApp.url,
    '--skip-crawl', '--skip-comprehend',
    '--run-suite',
  ];

  if (!existsSync(join(outputDir, 'context.json'))) {
    onProgress(`⚠️  no cached crawl for ${dApp.name} (${dApp.url}). Skipping run — would need OpenRouter credits + full pipeline.`);
    return {
      dApp: dApp.name, url: dApp.url, filter,
      exitCode: 2, durationMs: Date.now() - started,
      outputDir, results: null,
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
    };
  }

  const envExtra: NodeJS.ProcessEnv = { ...process.env };
  if (glob) envExtra.PLAYWRIGHT_GREP_FILES = glob;

  onProgress(`▶️  ${dApp.name} (${filter}) — starting`);

  const exitCode: number = await new Promise((resolve) => {
    const child = spawn('npx', args, {
      cwd: process.cwd(),
      env: envExtra,
      shell: true,
    });
    let buf = '';
    const emit = (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim()) onProgress(line);
      }
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('close', (code) => {
      if (buf.trim()) onProgress(buf);
      resolve(code ?? 1);
    });
  });

  const results = parseResults(outputDir);
  const summary = summarize(results);

  return {
    dApp: dApp.name, url: dApp.url, filter,
    exitCode, durationMs: Date.now() - started,
    outputDir, results, summary,
  };
}

function parseResults(outputDir: string): PlaywrightResults | null {
  const p = join(outputDir, 'results.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

export function summarize(r: PlaywrightResults | null): TestSummary {
  const out: TestSummary = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] };
  if (!r) return out;
  const walk = (suite: any, file: string) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          out.total++;
          if (result.status === 'passed') out.passed++;
          else if (result.status === 'skipped') out.skipped++;
          else {
            out.failed++;
            const err = result.error?.message ?? result.errors?.[0]?.message ?? 'unknown error';
            const screenshot = (result.attachments ?? []).find((a: any) => a.name === 'screenshot')?.path;
            out.failures.push({
              file: file,
              title: spec.title,
              error: String(err).slice(0, 2000),
              screenshot,
              duration: result.duration ?? 0,
            });
          }
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child, child.file ?? file);
  };
  for (const s of r.suites ?? []) walk(s, s.file ?? '');
  return out;
}

export function formatSummary(r: RunResult): string {
  const { summary: s, dApp, filter, durationMs, exitCode } = r;
  const emoji = s.failed > 0 ? '❌' : s.passed > 0 ? '✅' : '⚠️';
  const secs = (durationMs / 1000).toFixed(1);
  const head = `${emoji} **${dApp}** (${filter}) — ${s.passed}/${s.total} passed, ${s.failed} failed, ${s.skipped} skipped · ${secs}s (exit ${exitCode})`;
  if (s.failures.length === 0) return head;
  const fails = s.failures.slice(0, 5).map(f => `• \`${f.title}\` — ${f.error.split('\n')[0].slice(0, 180)}`).join('\n');
  const more = s.failures.length > 5 ? `\n…and ${s.failures.length - 5} more` : '';
  return `${head}\n${fails}${more}`;
}

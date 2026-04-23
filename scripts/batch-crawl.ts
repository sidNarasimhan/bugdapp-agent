#!/usr/bin/env npx tsx
/**
 * Batch crawl + spec-gen for a list of dApps. Runs them serially (they share
 * the project's MetaMask profile, so parallelism is unsafe). Each dApp gets
 * a 25-minute time-box — anything longer indicates a wallet-connect or
 * crawler hang we don't want to wait out.
 *
 * Per-dApp pipeline: crawler → kg-builder → flow-computer → flow-validator →
 * context-builder → (explorer SKIPPED) → planner → matrix-filler → spec-gen.
 * Explorer is skipped to avoid the known dApp-specific wallet-connect hangs;
 * the KG is already rich from the crawler + flow-computer output.
 *
 * Writes `output/batch-crawl-report.json` with per-dApp outcomes so the next
 * session (or a human) can see what worked without digging through logs.
 *
 * Usage:
 *   tsx scripts/batch-crawl.ts                       # runs the default set
 *   tsx scripts/batch-crawl.ts <host1> <host2> ...   # runs only those hostnames
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';
import { PROFILES } from '../src/agent/profiles/registry.js';

// Default queue — start with RainbowKit/Wagmi dApps most likely to work like
// Aave did. Add the exotic ones in a second batch once these land.
const DEFAULT_TIER_1 = [
  'app-morpho-org',       // lending, Base — same archetype as Aave
  'app-compound-finance', // lending
  'aerodrome-finance',    // swap, Base — co-located with Avantis infrastructure
  'balancer-fi',          // swap
  'velodrome-finance',    // swap, Optimism
  'app-gmx-io',           // perps peer to Avantis, Arbitrum
  'app-vertexprotocol-com', // perps
];

interface Outcome {
  hostname: string;
  url: string;
  status: 'success' | 'timeout' | 'error' | 'skipped';
  durationSec: number;
  kg: { pages: number; components: number; flows: number; edges: number };
  specs: number;
  tests: number;
  detail: string;
}

const TIME_BOX_MS = 25 * 60 * 1000; // 25 min

async function runOne(hostname: string): Promise<Outcome> {
  const profile = PROFILES.find(p => new URL(p.url).hostname.replace(/\./g, '-') === hostname);
  if (!profile) {
    return {
      hostname, url: '',
      status: 'error', durationSec: 0,
      kg: { pages: 0, components: 0, flows: 0, edges: 0 },
      specs: 0, tests: 0,
      detail: `no profile found for hostname "${hostname}"`,
    };
  }

  const outputDir = join(process.cwd(), 'output', hostname);
  mkdirSync(outputDir, { recursive: true });

  // If this dApp already has a real KG, skip it so we don't overwrite work.
  const kgPath = join(outputDir, 'knowledge-graph.json');
  if (existsSync(kgPath)) {
    try {
      const existing = JSON.parse(readFileSync(kgPath, 'utf8'));
      if ((existing.components || []).length > 0) {
        return {
          hostname, url: profile.url,
          status: 'skipped', durationSec: 0,
          kg: {
            pages: existing.pages?.length ?? 0,
            components: existing.components?.length ?? 0,
            flows: existing.flows?.length ?? 0,
            edges: existing.edges?.length ?? 0,
          },
          specs: 0, tests: 0,
          detail: 'already has real KG, not re-crawled (pass --force to override, or delete knowledge-graph.json first)',
        };
      }
    } catch {}
  }

  const started = Date.now();
  console.log(`\n━━━ [${hostname}] starting pipeline — ${profile.url} ━━━`);

  let status: Outcome['status'] = 'success';
  let detail = '';
  try {
    const args = [
      'tsx', 'scripts/run-pipeline.ts',
      '--url', profile.url,
      '--skip-explorer',
      '--stop-after', 'spec_generator',
    ];
    const child = execa('npx', args, {
      cwd: process.cwd(),
      env: process.env,
      timeout: TIME_BOX_MS,
      stdio: 'inherit',
      reject: false,
    });
    const result = await child;
    if (result.timedOut) {
      status = 'timeout';
      detail = `hit ${TIME_BOX_MS / 1000 / 60}-minute time-box`;
    } else if (result.exitCode !== 0) {
      status = 'error';
      detail = `pipeline exited ${result.exitCode}`;
    } else {
      detail = 'pipeline completed';
    }
  } catch (err: any) {
    status = 'error';
    detail = `spawn threw: ${err?.message ?? err}`;
  }

  const durationSec = Math.round((Date.now() - started) / 1000);

  // Measure outcome on disk.
  let kg = { pages: 0, components: 0, flows: 0, edges: 0 };
  if (existsSync(kgPath)) {
    try {
      const k = JSON.parse(readFileSync(kgPath, 'utf8'));
      kg = {
        pages: k.pages?.length ?? 0,
        components: k.components?.length ?? 0,
        flows: k.flows?.length ?? 0,
        edges: k.edges?.length ?? 0,
      };
    } catch {}
  }

  let specs = 0, tests = 0;
  const testsDir = join(outputDir, 'tests');
  if (existsSync(testsDir)) {
    for (const f of (await import('fs')).readdirSync(testsDir)) {
      if (!f.endsWith('.spec.ts')) continue;
      specs++;
      tests += (readFileSync(join(testsDir, f), 'utf8').match(/^\s*test\(['"`]/gm) || []).length;
    }
  }

  // Promote to 'success' only if we actually got real KG data AND specs.
  if (status === 'success' && (kg.components === 0 || specs === 0)) {
    status = 'error';
    detail += ' (no real KG or no specs produced — crawler likely couldn\'t reach the dApp)';
  }

  return { hostname, url: profile.url, status, durationSec, kg, specs, tests, detail };
}

async function main() {
  const argHosts = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const queue = argHosts.length > 0 ? argHosts : DEFAULT_TIER_1;

  console.log(`[batch] queue: ${queue.length} dApp(s) — ${queue.join(', ')}`);
  console.log(`[batch] time-box per dApp: ${TIME_BOX_MS / 60000} minutes`);
  console.log(`[batch] total worst-case: ${(TIME_BOX_MS * queue.length) / 60000} minutes`);

  const outcomes: Outcome[] = [];
  for (let i = 0; i < queue.length; i++) {
    const hostname = queue[i];
    console.log(`\n[batch] ${i + 1}/${queue.length}: ${hostname}`);
    const outcome = await runOne(hostname);
    outcomes.push(outcome);

    const mark = { success: '✓', timeout: '⏱', error: '✗', skipped: '◌' }[outcome.status];
    console.log(`[batch] ${mark} ${hostname} — ${outcome.status} (${outcome.durationSec}s) — kg: ${outcome.kg.components}c/${outcome.kg.flows}f, specs: ${outcome.specs}/${outcome.tests}t — ${outcome.detail}`);

    // Snapshot progress after each dApp so a kill doesn't lose the report.
    writeFileSync(join(process.cwd(), 'output', 'batch-crawl-report.json'),
      JSON.stringify({ startedAt: new Date(Date.now() - outcomes.reduce((s, o) => s + o.durationSec * 1000, 0)).toISOString(), updatedAt: new Date().toISOString(), queue, outcomes }, null, 2));
  }

  // Final summary.
  console.log(`\n━━━ batch summary ━━━`);
  const succeeded = outcomes.filter(o => o.status === 'success');
  const skipped = outcomes.filter(o => o.status === 'skipped');
  const timedOut = outcomes.filter(o => o.status === 'timeout');
  const errored = outcomes.filter(o => o.status === 'error');
  console.log(`  ✓ success:  ${succeeded.length}`);
  console.log(`  ◌ skipped:  ${skipped.length}`);
  console.log(`  ⏱ timeout:  ${timedOut.length}`);
  console.log(`  ✗ error:    ${errored.length}`);

  for (const o of outcomes) {
    const mark = { success: '✓', timeout: '⏱', error: '✗', skipped: '◌' }[o.status];
    console.log(`  ${mark} ${o.hostname.padEnd(30)} ${o.kg.components}c/${o.kg.flows}f — ${o.specs}s/${o.tests}t`);
  }

  console.log(`\n  report: output/batch-crawl-report.json`);
}

main().catch(e => { console.error('[batch] fatal:', e); process.exit(1); });

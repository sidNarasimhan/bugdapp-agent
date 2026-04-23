#!/usr/bin/env npx tsx
/**
 * Adversarial scenario runner — CLI around `runAdversarial` in
 * src/agent/nodes/adversarial.ts. Dry-run by default (no LLM cost) —
 * pass --live to call the model.
 *
 * Usage:
 *   tsx scripts/run-adversarial.ts <hostname-dir>            # dry-run scaffold
 *   tsx scripts/run-adversarial.ts <hostname-dir> --live     # LLM-enriched
 *   tsx scripts/run-adversarial.ts <hostname-dir> --live --model openai/gpt-4o-mini
 */
import 'dotenv/config';
import { join } from 'path';
import { existsSync } from 'fs';
import { PROFILES } from '../src/agent/profiles/registry.js';
import { runAdversarial } from '../src/agent/nodes/adversarial.js';

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error('usage: tsx scripts/run-adversarial.ts <hostname-dir> [--live] [--model <slug>]');
  console.error('example: tsx scripts/run-adversarial.ts developer-avantisfi-com');
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();
  const hostname = argv[0];
  const live = argv.includes('--live');
  const modelIdx = argv.indexOf('--model');
  const model = modelIdx >= 0 ? argv[modelIdx + 1] : undefined;

  const profile = PROFILES.find(p => new URL(p.url).hostname.replace(/\./g, '-') === hostname);
  if (!profile) usage(`no profile for hostname "${hostname}"`);

  const outputDir = join(process.cwd(), 'output', hostname);
  if (!existsSync(outputDir)) usage(`output dir missing: ${outputDir}`);

  try {
    const report = await runAdversarial(profile, {
      outputDir,
      mode: live ? 'live' : 'dry-run',
      model,
    });
    console.log(`\n━━━ ${profile.name} adversarial report ━━━`);
    console.log(`mode: ${report.mode}${report.model ? ' / ' + report.model : ''}`);
    console.log(`scenarios: ${report.scenarios.length}`);
    for (const s of report.scenarios) {
      console.log(`  • [${s.severity.toUpperCase()}] ${s.id} — ${s.name}`);
    }
    console.log(`\nnotes: ${report.notes}`);
  } catch (err: any) {
    console.error(`\n✗ failed: ${err?.message ?? err}`);
    process.exit(2);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env npx tsx
/**
 * Self-healing test runner.
 *
 *   npm run run
 *   npm run run -- --grep perps-primary.spec.ts
 *
 * Phase 1: Playwright on tests/ (deterministic, $0).
 * Phase 2: For each failure, run the executor agent to recover + heal .spec.ts.
 * Phase 3: Re-run healed specs under pure Playwright to verify.
 */
import 'dotenv/config';
import { runSuiteWithHealing, formatHealSummary } from '../src/pipeline/heal-runner.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const grep = arg('grep');
  const noVerify = process.argv.includes('--no-verify');
  const summary = await runSuiteWithHealing({
    specFilter: grep,
    verifyAfterHeal: !noVerify,
    onLine: (l) => console.log(l),
  });
  console.log('\n' + formatHealSummary(summary));
  process.exit(summary.unhealed.length > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

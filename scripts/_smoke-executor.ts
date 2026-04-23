#!/usr/bin/env npx tsx
/**
 * LLM-driven executor smoke test. Simple no-wallet task:
 *   "Snapshot the Avantis trade page and report which asset is selected in the header."
 *
 * Validates: Sonnet 4.5 tool use, snapshot -> reason -> task_complete loop.
 * Cost: ~$0.05.
 */
import 'dotenv/config';
import { runExecutor } from '../src/chat/agent/executor.js';
import { resetSession } from '../src/chat/agent/session.js';

async function main() {
  console.log('[smoke] running executor on no-wallet task...');
  const result = await runExecutor({
    task: 'Take a snapshot of the current page and report which trading asset is shown in the header (e.g. BTC-USD, ETH-USD). Do not connect a wallet. Finish via task_complete with the asset symbol as the summary.',
  }, (step) => {
    const preview = step.output.split('\n').slice(0, 1).join(' ').slice(0, 120);
    const mark = step.success ? '✓' : '✗';
    console.log(`  ${mark} [${step.iteration}] ${step.tool} — ${preview}`);
  });

  console.log('\n━━━ RESULT ━━━');
  console.log(`outcome:         ${result.outcome}`);
  console.log(`summary:         ${result.summary}`);
  console.log(`steps:           ${result.steps.length}`);
  console.log(`tokens:          ~${Math.round(result.tokensUsed / 1000)}k`);
  console.log(`duration:        ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`model:           ${result.model}`);
  if (result.abortReason) console.log(`abort reason:    ${result.abortReason}`);
  if (result.terminalState) console.log(`terminal state:  ${result.terminalState}`);

  await resetSession();
  process.exit(result.outcome === 'complete' ? 0 : 1);
}

main().catch(e => { console.error('[smoke] CRASHED:', e?.message ?? e); process.exit(1); });

#!/usr/bin/env npx tsx
/**
 * Wallet connect smoke test. Task: connect MM to Avantis via Privy.
 * No tx submitted — just the handshake.
 */
import 'dotenv/config';
import { runExecutor } from '../src/chat/agent/executor.js';
import { resetSession } from '../src/chat/agent/session.js';

async function main() {
  console.log('[smoke] running executor: connect wallet to Avantis');
  const result = await runExecutor({
    task: 'Connect the MetaMask wallet to Avantis. Avantis uses a Privy-wrapped connect flow. Steps: 1) find and click the primary Login/Connect button on the page. 2) In the Privy modal, look for "Continue with a wallet" or similar and click it. 3) Pick MetaMask from the list. 4) Call wallet_approve_connection to approve the MM popup + SIWE signature. 5) After approval, take a snapshot and verify the wallet is connected (look for a wallet address in the header or the "Connect" button disappearing). 6) Call task_complete with the observed wallet state, or task_failed with the terminal state if connection did not complete.',
  }, (step) => {
    const preview = step.output.split('\n').slice(0, 1).join(' ').slice(0, 140);
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

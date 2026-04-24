/**
 * dApp-agnostic context prompt. Takes the ActiveDApp (resolved from
 * comprehension.json + chain registry) and emits a short system-prompt block
 * the executor prepends before the KG knowledge block.
 *
 * All substantive per-dApp knowledge (min amounts, leverage bounds, connect
 * flow quirks) comes from src/agent/knowledge.ts which reads comprehension +
 * KG off disk. This file only adds identity + archetype playbook.
 */
import type { ActiveDApp } from '../config.js';

const ARCHETYPE_PLAYBOOKS: Record<string, string> = {
  perps: [
    '## ARCHETYPE PLAYBOOK: perpetual futures',
    '1. Pick asset via selector (e.g. "ETH-USD", "BTC-USD").',
    '2. Choose direction: Long or Short.',
    '3. Choose order type: Market (fastest), Limit, or Stop.',
    '4. Set leverage via slider or input.',
    '5. Set collateral amount (must satisfy min position / leverage).',
    '6. Primary CTA cycles: "Approve <TOKEN>" -> "Open Long"/"Open Short" -> post-submit.',
    '7. On Approve: click, then `wallet_confirm_transaction`. Retry CTA.',
    '8. On Open: click, then `wallet_confirm_transaction`. Wait for tx success.',
  ].join('\n'),
  swap: '## ARCHETYPE PLAYBOOK: token swap\n1. From asset + amount. 2. To asset. 3. Quote. 4. Approve -> Swap. 5. Confirm tx.',
  lending: '## ARCHETYPE PLAYBOOK: lending\n1. Pick market. 2. Supply or Borrow. 3. Amount. 4. Approve -> Supply/Borrow. 5. Confirm tx.',
  staking: '## ARCHETYPE PLAYBOOK: staking\n1. Stake input. 2. Amount. 3. Approve -> Stake. 4. Confirm tx.',
  cdp: '## ARCHETYPE PLAYBOOK: CDP\n1. Open/select vault. 2. Set collateral + debt. 3. Approve -> Deposit -> Borrow. 4. Confirm each tx.',
  yield: '## ARCHETYPE PLAYBOOK: yield\n1. Pick pool. 2. Deposit amount. 3. Approve -> Deposit. 4. Confirm tx.',
  lp: '## ARCHETYPE PLAYBOOK: LP\n1. Pick pool. 2. Both amounts. 3. Approve both. 4. Add liquidity. 5. Confirm tx.',
  bridge: '## ARCHETYPE PLAYBOOK: bridge\n1. Source + dest + asset + amount. 2. Approve. 3. Bridge. 4. Confirm tx (don\'t wait for destination).',
};

const TERMINAL_STATES = [
  '## TERMINAL STATES',
  'Before submitting, classify the form state:',
  '- `ready-to-action`: primary CTA visible + enabled',
  '- `needs-approval`: CTA says "Approve <TOKEN>"',
  '- `wrong-network`: CTA says "Switch to X" / "Wrong Network"',
  '- `unfunded`: CTA says "Insufficient" / "Add Funds" / "Get Funds"',
  '- `unconnected`: CTA says "Connect Wallet" / "Login"',
  '- `min-amount` / `max-amount`: amount out of bounds',
  '',
  'Call `task_failed` with the terminal state if you cannot proceed; do not brute-force.',
].join('\n');

export function dAppContextPrompt(dapp: ActiveDApp): string {
  const chainHex = '0x' + dapp.chain.id.toString(16);
  const parts = [
    `## DAPP CONTEXT: ${dapp.name} (${dapp.url})`,
    '',
    `- Archetype: ${dapp.archetype}`,
    `- Network: ${dapp.chain.name} (chainId ${dapp.chain.id}, hex ${chainHex})`,
    `- Native currency: ${dapp.chain.nativeCurrency.symbol}`,
    `- Block explorer: ${dapp.chain.blockExplorers?.default.url ?? ''}`,
    '',
    ARCHETYPE_PLAYBOOKS[dapp.archetype] ?? '## ARCHETYPE PLAYBOOK: (unknown — rely on KG knowledge block)',
    '',
    TERMINAL_STATES,
  ];
  return parts.join('\n');
}

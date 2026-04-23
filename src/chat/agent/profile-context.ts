/**
 * Profile-driven context prompt. Works with any DAppProfile.
 *
 * Generates the per-task system prompt addition the executor sees. Includes:
 *   - dApp identity, URL, chain
 *   - Archetype-specific flow hints (perps / swap / lending / ...)
 *   - Connect-modal hints from the profile
 *   - Inverse flows (close/withdraw/repay)
 *   - Terminal state taxonomy
 */
import type { DAppProfile, ArchetypeName } from '../../agent/profiles/types.js';

const ARCHETYPE_PLAYBOOKS: Record<ArchetypeName, string> = {
  perps: [
    '## ARCHETYPE PLAYBOOK: perpetual futures',
    '1. Pick asset via selector (e.g. "ETH-USD", "BTC-USD").',
    '2. Choose direction: Long or Short.',
    '3. Choose order type: Market (fastest), Limit, or Stop.',
    '4. Set leverage via slider or input.',
    '5. Set collateral amount (must be >= min position / leverage).',
    '6. Primary CTA cycles: "Approve USDC" -> "Open Long"/"Open Short" -> post-submit.',
    '7. On Approve: click, then `wallet_confirm_transaction`. Retry CTA.',
    '8. On Open: click, then `wallet_confirm_transaction`. Wait for tx success.',
  ].join('\n'),

  swap: [
    '## ARCHETYPE PLAYBOOK: token swap',
    '1. Set "From" asset + amount.',
    '2. Set "To" asset.',
    '3. Wait for quote.',
    '4. Primary CTA cycles: "Approve <TOKEN>" -> "Swap" -> post-submit.',
    '5. On Approve: click, `wallet_confirm_transaction`. Retry CTA.',
    '6. On Swap: click, `wallet_confirm_transaction`. Verify receipt.',
  ].join('\n'),

  lending: [
    '## ARCHETYPE PLAYBOOK: lending (supply/borrow)',
    '1. Navigate to the target asset row in the market table.',
    '2. Click Supply or Borrow.',
    '3. Set amount.',
    '4. Primary CTA: "Approve <TOKEN>" -> "Supply"/"Borrow".',
    '5. Approve, then confirm tx, verify receipt.',
  ].join('\n'),

  staking: [
    '## ARCHETYPE PLAYBOOK: staking',
    '1. Find stake input.',
    '2. Set amount.',
    '3. Primary CTA: Approve -> Stake.',
    '4. Confirm tx, verify.',
  ].join('\n'),

  cdp: [
    '## ARCHETYPE PLAYBOOK: collateralized debt position',
    '1. Open or select vault.',
    '2. Set collateral amount + debt amount.',
    '3. CTA cycles: Approve -> Deposit -> Borrow.',
    '4. Confirm each tx.',
  ].join('\n'),

  yield: [
    '## ARCHETYPE PLAYBOOK: yield / farming',
    '1. Pick pool/strategy.',
    '2. Set deposit amount.',
    '3. Approve -> Deposit.',
    '4. Confirm tx, verify.',
  ].join('\n'),

  lp: [
    '## ARCHETYPE PLAYBOOK: liquidity provision',
    '1. Pick pool.',
    '2. Set both amounts (or use "max").',
    '3. Approve both tokens if needed.',
    '4. Add liquidity, confirm tx.',
  ].join('\n'),

  bridge: [
    '## ARCHETYPE PLAYBOOK: bridge',
    '1. Set source chain, dest chain, asset, amount.',
    '2. Approve (if needed), Bridge.',
    '3. Confirm tx. Note: bridging takes minutes — don\'t wait for destination confirmation.',
  ].join('\n'),
};

export function profileContextPrompt(p: DAppProfile): string {
  const parts: string[] = [];

  parts.push(`## DAPP CONTEXT: ${p.name} (${p.url})`);
  parts.push('');
  parts.push(`- Archetype: ${p.archetype}`);
  parts.push(`- Network: ${p.network.chain} (chainId ${p.network.chainId}, hex ${p.network.chainHexId})`);
  parts.push(`- Block explorer: ${p.network.blockExplorerUrl}`);
  parts.push(`- Native currency: ${p.network.nativeCurrency.symbol}`);
  if (p.values.minPositionSizeUsd !== undefined) {
    parts.push(`- Min position size: $${p.values.minPositionSizeUsd}`);
  }
  if (p.values.preferredAmountUsd !== undefined) {
    parts.push(`- Typical test amount: $${p.values.preferredAmountUsd} ${p.archetype === 'perps' && p.values.targetLeverage ? `× ${p.values.targetLeverage}x` : ''}`);
  }
  if (p.values.slippageBps !== undefined) {
    parts.push(`- Default slippage: ${p.values.slippageBps} bps`);
  }
  if (p.notes) {
    parts.push('');
    parts.push(`Notes: ${p.notes}`);
  }
  parts.push('');
  parts.push(ARCHETYPE_PLAYBOOKS[p.archetype] ?? '');
  parts.push('');

  // Connect hints
  if (p.selectors?.connect) {
    parts.push('## CONNECT FLOW HINTS');
    if (p.selectors.connect.preMetaMaskClicks?.length) {
      parts.push(`Before selecting MetaMask, try these clicks (fire-and-forget, missing is OK):`);
      for (const c of p.selectors.connect.preMetaMaskClicks) {
        parts.push(`  - "${String(c)}"`);
      }
    }
    if (p.selectors.connect.loginButtonPattern) {
      parts.push(`Primary login button pattern: ${p.selectors.connect.loginButtonPattern}`);
    }
    parts.push('');
  }

  // Inverse flows
  if (p.inverseFlows && p.inverseFlows.length > 0) {
    parts.push('## INVERSE FLOWS (close/withdraw/repay)');
    for (const f of p.inverseFlows) {
      parts.push(`- **${f.name}** at route \`${f.route}\`, CTA matches ${f.ctaPattern}${f.confirmPattern ? `, confirm matches ${f.confirmPattern}` : ''}`);
    }
    parts.push('');
  }

  // Always include terminal states
  parts.push(TERMINAL_STATES);

  return parts.join('\n');
}

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

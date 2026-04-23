/**
 * Staking archetype — liquid staking tokens (LSTs) and direct staking.
 * Examples: Lido, Rocket Pool, Frax Ether, Jito (Solana later), Swell.
 *
 * Shape: amount → (Approve for LP-type) → Stake → receive LST.
 * Inverse: unstake/withdraw — often queued with a delay.
 */

import type { ValueConfig } from '../profiles/types.js';
import type { Archetype, ClassifyContext } from './types.js';
import { classifyCommon } from './types.js';

const PRIMARY_ACTION_PATTERN = /^(Stake|Deposit|Confirm Stake|Confirm Deposit|Mint)$/i;

const DEFAULT_CTA_TIERS: RegExp[] = [
  /^(Stake|Deposit|Confirm Stake|Confirm Deposit|Mint)$/i,
  /^(Approve|Unlock|Enable) .*/i,
  /^(Enter an amount|Enter amount)$/i,
  /^(Switch to [A-Za-z ]+|Switch Network|Wrong Network|Unsupported Network)$/i,
  /^(Connect Wallet|Login|Connect)$/i,
];

function isPrimary(text: string): boolean {
  return PRIMARY_ACTION_PATTERN.test(text.trim());
}

export const stakingArchetype: Archetype = {
  name: 'staking',
  defaultCtaTiers: DEFAULT_CTA_TIERS,
  primaryActionPattern: PRIMARY_ACTION_PATTERN,

  pickValues(values: ValueConfig) {
    const amount = values.preferredAmountUsd ?? 10;
    return { collateral: String(amount), leverage: '0', amount: String(amount) };
  },

  classify(ctx: ClassifyContext) {
    return classifyCommon(ctx, isPrimary);
  },

  isPrimaryActionCta: isPrimary,
};

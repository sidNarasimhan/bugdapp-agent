/**
 * Yield archetype — auto-compounding vaults and yield trading.
 * Examples: Yearn, Pendle, Convex, Beefy.
 *
 * Shape: deposit asset → receive vault token / PT / YT → yield accrues → withdraw.
 */

import type { ValueConfig } from '../profiles/types.js';
import type { Archetype, ClassifyContext } from './types.js';
import { classifyCommon } from './types.js';

const PRIMARY_ACTION_PATTERN = /^(Deposit|Stake|Buy PT|Buy YT|Swap|Confirm Deposit|Enter Vault)$/i;

const DEFAULT_CTA_TIERS: RegExp[] = [
  /^(Deposit|Stake|Buy PT|Buy YT|Swap|Enter Vault)$/i,
  /^Confirm Deposit$/i,
  /^(Approve|Unlock|Enable) .*/i,
  /^(Switch to [A-Za-z ]+|Switch Network|Wrong Network|Unsupported Network)$/i,
  /^(Connect Wallet|Login|Connect)$/i,
];

function isPrimary(text: string): boolean {
  return PRIMARY_ACTION_PATTERN.test(text.trim());
}

export const yieldArchetype: Archetype = {
  name: 'yield',
  defaultCtaTiers: DEFAULT_CTA_TIERS,
  primaryActionPattern: PRIMARY_ACTION_PATTERN,

  pickValues(values: ValueConfig) {
    const amount = values.preferredAmountUsd ?? 5;
    return { collateral: String(amount), leverage: '0', amount: String(amount) };
  },

  classify(ctx: ClassifyContext) {
    return classifyCommon(ctx, isPrimary);
  },

  isPrimaryActionCta: isPrimary,
};

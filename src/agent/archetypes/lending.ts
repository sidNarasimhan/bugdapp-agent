/**
 * Lending archetype — money markets: Aave, Compound, Morpho, Venus, Benqi, Radiant, Moonwell.
 *
 * Shared shape:
 *   - Pick asset
 *   - Choose Supply / Borrow / Repay / Withdraw
 *   - Enter amount
 *   - (Approve) → Submit
 *
 * Inverse pairs: Supply ↔ Withdraw, Borrow ↔ Repay.
 */

import type { ValueConfig } from '../../types.js';
import type { Archetype, ClassifyContext } from './types.js';
import { classifyCommon } from './types.js';

const PRIMARY_ACTION_PATTERN = /^(Supply|Borrow|Repay|Withdraw|Deposit|Lend|Confirm Supply|Confirm Borrow|Confirm Repay|Confirm Withdraw|Confirm Deposit)$/i;

const DEFAULT_CTA_TIERS: RegExp[] = [
  /^(Supply|Borrow|Repay|Withdraw|Deposit|Lend)$/i,
  /^Confirm (Supply|Borrow|Repay|Withdraw|Deposit)$/i,
  /^(Approve|Unlock|Enable) .*/i,
  /^(Enter an amount|Enter amount)$/i,
  /^(Switch to [A-Za-z ]+|Switch Network|Wrong Network|Unsupported Network)$/i,
  /^(Connect Wallet|Login|Connect)$/i,
];

function isPrimary(text: string): boolean {
  return PRIMARY_ACTION_PATTERN.test(text.trim());
}

export const lendingArchetype: Archetype = {
  name: 'lending',
  defaultCtaTiers: DEFAULT_CTA_TIERS,
  primaryActionPattern: PRIMARY_ACTION_PATTERN,

  pickValues(values: ValueConfig) {
    const amount = values.preferredAmountUsd ?? 10;
    return {
      collateral: String(amount),
      leverage: '0',
      amount: String(amount),
    };
  },

  classify(ctx: ClassifyContext) {
    return classifyCommon(ctx, isPrimary);
  },

  isPrimaryActionCta: isPrimary,
};

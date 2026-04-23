/**
 * Swap archetype — AMMs and aggregators: Uniswap, Curve, PancakeSwap, Aerodrome,
 * Velodrome, Trader Joe, QuickSwap, 1inch, Jupiter (non-EVM, later).
 *
 * Shared shape:
 *   - fromToken + toToken + amount
 *   - (Approve token) → Swap
 *   - Output amount is quoted, slippage bounded
 *
 * Inverse: reverse-direction swap (swap same amount of toToken back to fromToken).
 * Unlike perps, there's no "position" to close — the inverse is a second swap.
 */

import type { ValueConfig } from '../profiles/types.js';
import type { Archetype, ClassifyContext } from './types.js';
import { classifyCommon } from './types.js';

const PRIMARY_ACTION_PATTERN = /^(Swap|Confirm Swap|Review Swap|Exchange|Trade|Buy|Sell)$/i;

const DEFAULT_CTA_TIERS: RegExp[] = [
  /^(Swap|Confirm Swap|Review Swap|Exchange|Buy|Sell)$/i,
  /^Trade$/i,
  /^(Approve|Unlock|Enable) .*/i,
  /^(Insufficient [A-Za-z]+ balance)$/i,  // treated as blocker
  /^(Switch to [A-Za-z ]+|Switch Network|Wrong Network|Unsupported Network)$/i,
  /^(Connect Wallet|Login|Connect)$/i,
  /^(Enter an amount|Select a token)$/i,
];

function isPrimary(text: string): boolean {
  return PRIMARY_ACTION_PATTERN.test(text.trim());
}

export const swapArchetype: Archetype = {
  name: 'swap',
  defaultCtaTiers: DEFAULT_CTA_TIERS,
  primaryActionPattern: PRIMARY_ACTION_PATTERN,

  pickValues(values: ValueConfig) {
    // Swap just needs an input amount — no leverage, no collateral concept.
    const amount = values.preferredAmountUsd ?? 1;
    return {
      collateral: String(amount), // re-used by generic "Fill amount" steps
      leverage: '0', // unused
      amount: String(amount),
    };
  },

  classify(ctx: ClassifyContext) {
    const base = classifyCommon(ctx, isPrimary);
    // Swap-specific: "Insufficient X balance" is a disabled-button state, not a blocker CTA.
    if (base.state === 'unknown' && /insufficient.*balance/i.test(ctx.ctaText)) {
      return { ...base, state: 'unfunded' };
    }
    if (base.state === 'unknown' && /^(Enter an amount|Select a token)$/i.test(ctx.ctaText)) {
      // Form incomplete — not a real blocker, but the test didn't fill correctly.
      return { ...base, state: 'unknown' };
    }
    return base;
  },

  isPrimaryActionCta: isPrimary,
};

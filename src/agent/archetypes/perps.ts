/**
 * Perps archetype — leveraged perpetual DEXes: Avantis, GMX, Vertex, Hyperliquid, dYdX, etc.
 *
 * Shared shape:
 *   - User selects asset (market)
 *   - Picks direction (Long / Short)
 *   - Enters collateral (and/or leverage)
 *   - Optionally sets TP/SL, order type (market/limit/stop)
 *   - Submits → wallet sign → position opens
 *
 * Inverse: close position from a portfolio / positions page.
 */

import type { ValueConfig } from '../profiles/types.js';
import type { Archetype, ClassifyContext } from './types.js';
import { classifyCommon } from './types.js';

const PRIMARY_ACTION_PATTERN = /^(Place Order|Confirm Order|Open Long|Open Short|Market Long|Market Short|Limit Long|Limit Short|Trade|Submit Order|Send Order|Place Trade)$/i;
const PRIMARY_ACTION_PATTERNS: RegExp[] = [PRIMARY_ACTION_PATTERN];

const DEFAULT_CTA_TIERS: RegExp[] = [
  /^(Place Order|Confirm Order|Open Long|Open Short|Market Long|Market Short|Submit Order|Send Order|Place Trade)$/i,
  /^Trade$/i,
  /^(Approve USDC|Approve)$/i,
  /^(Add Funds|Get Funds)$/i,
  /^(Switch to [A-Za-z ]+|Switch Network|Wrong Network|Unsupported Network)$/i,
  /^(Connect Wallet|Login|Connect)$/i,
  /^(Enable Smart Wallet|Enable)$/i,
];

function isPrimary(text: string): boolean {
  return PRIMARY_ACTION_PATTERN.test(text.trim());
}

export const perpsArchetype: Archetype = {
  name: 'perps',
  defaultCtaTiers: DEFAULT_CTA_TIERS,
  primaryActionPattern: PRIMARY_ACTION_PATTERN,

  pickValues(values: ValueConfig) {
    // Perps requires collateral × leverage >= min position size.
    // Target the configured leverage; calculate collateral so position >= min.
    const minPosition = values.minPositionSizeUsd ?? 0;
    const leverage = values.targetLeverage ?? 10;
    const preferredCollateral = values.preferredAmountUsd ?? 10;
    const requiredCollateral = minPosition > 0 ? Math.ceil(minPosition / leverage) + 5 : preferredCollateral;
    const collateral = Math.max(preferredCollateral, requiredCollateral);
    return {
      collateral: String(collateral),
      leverage: String(leverage),
      amount: String(collateral), // for steps that say "Fill amount"
    };
  },

  classify(ctx: ClassifyContext) {
    return classifyCommon(ctx, isPrimary);
  },

  isPrimaryActionCta: isPrimary,
};

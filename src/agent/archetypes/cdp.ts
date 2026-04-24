/**
 * CDP (Collateralized Debt Position) archetype — mint stablecoin against collateral.
 * Examples: Sky (Maker), Liquity, Inverse, Prisma.
 *
 * Shape: lock collateral → choose debt amount → mint/open vault.
 * Inverse: repay debt → withdraw collateral.
 */

import type { ValueConfig } from '../../types.js';
import type { Archetype, ClassifyContext } from './types.js';
import { classifyCommon } from './types.js';

const PRIMARY_ACTION_PATTERN = /^(Open Vault|Mint|Generate|Create Vault|Borrow|Supply|Confirm)$/i;

const DEFAULT_CTA_TIERS: RegExp[] = [
  /^(Open Vault|Mint|Generate|Create Vault|Borrow|Supply)$/i,
  /^Confirm$/i,
  /^(Approve|Unlock|Enable) .*/i,
  /^(Switch to [A-Za-z ]+|Switch Network|Wrong Network|Unsupported Network)$/i,
  /^(Connect Wallet|Login|Connect)$/i,
];

function isPrimary(text: string): boolean {
  return PRIMARY_ACTION_PATTERN.test(text.trim());
}

export const cdpArchetype: Archetype = {
  name: 'cdp',
  defaultCtaTiers: DEFAULT_CTA_TIERS,
  primaryActionPattern: PRIMARY_ACTION_PATTERN,

  pickValues(values: ValueConfig) {
    const amount = values.preferredAmountUsd ?? 50;
    return { collateral: String(amount), leverage: '0', amount: String(amount) };
  },

  classify(ctx: ClassifyContext) {
    return classifyCommon(ctx, isPrimary);
  },

  isPrimaryActionCta: isPrimary,
};

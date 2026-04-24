/**
 * Archetype — generic logic for one category of dApp (perps, swap, lending, etc.).
 *
 * An archetype knows:
 *   - The default CTA verb tiers ("Trade" / "Swap" / "Supply" / ...)
 *   - How to classify terminal states from page text hints
 *   - How to compute valid input values from constraints
 *   - How to express inverse/cleanup flows
 *
 * A profile plugs into one archetype. The archetype provides defaults; the profile
 * overrides specific quirks.
 */

import type { ValueConfig, ClassifiedCta, TerminalState } from '../../types.js';

/** Runtime context passed to archetype classifiers — strings scraped from the live page at test time. */
export interface ClassifyContext {
  ctaText: string;
  ctaDisabled: boolean;
  pageText: string;
}

export interface Archetype {
  name: string;

  /** Default CTA tier patterns (primary action first, blockers last). Profiles can override. */
  defaultCtaTiers: RegExp[];

  /** Single regex matching any PRIMARY action CTA — serialized into generated specs for runtime classification. */
  primaryActionPattern: RegExp;

  /** Derive concrete input values (collateral, amount, leverage) from profile config. */
  pickValues(values: ValueConfig): { collateral: string; leverage: string; amount: string };

  /** Classify the terminal state of the form from live page signals. */
  classify(ctx: ClassifyContext): ClassifiedCta;

  /** Runtime convenience — used by non-generated code. */
  isPrimaryActionCta(ctaText: string): boolean;
}

/**
 * Shared classifier helper — most archetypes want the same priority order for blockers,
 * differing only in what counts as a "primary action" CTA.
 */
export function classifyCommon(
  ctx: ClassifyContext,
  isPrimary: (text: string) => boolean,
): ClassifiedCta {
  const { ctaText, ctaDisabled, pageText } = ctx;

  let state: TerminalState = 'unknown';

  if (isPrimary(ctaText) && !ctaDisabled) {
    state = 'ready-to-action';
  } else if (/^Approve/i.test(ctaText)) {
    state = 'needs-approval';
  } else if (/Switch to|Wrong Network|Unsupported Network|Change Network/i.test(ctaText)) {
    state = 'wrong-network';
  } else if (/^(Add Funds|Get Funds)$/i.test(ctaText)) {
    state = 'unfunded';
  } else if (/^(Connect Wallet|Login|Connect)$/i.test(ctaText)) {
    state = 'unconnected';
  } else if (isPrimary(ctaText) && ctaDisabled) {
    // Primary CTA visible but disabled — diagnose from page text
    if (/insufficient|not enough|exceeds balance/i.test(pageText)) state = 'unfunded';
    else if (/Minimum.*(is below|required|not met)|Position size is too (low|small)|below minimum/i.test(pageText)) state = 'min-amount';
    else if (/Maximum|exceeds max|above maximum|over limit/i.test(pageText)) state = 'max-amount';
    else if (/Switch to|Wrong Network|Change Network/i.test(pageText)) state = 'wrong-network';
    else state = 'unknown';
  }

  return { state, ctaText, ctaDisabled };
}

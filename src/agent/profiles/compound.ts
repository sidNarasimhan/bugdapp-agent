import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const compoundProfile: DAppProfile = {
  name: 'Compound',
  urlMatches: ['app.compound.finance'],
  url: 'https://app.compound.finance/',
  archetype: 'lending',
  network: NETWORKS.ethereum,
  values: { preferredAmountUsd: 5 },
  selectors: { navExcludeSelector: 'nav, header' },
  inverseFlows: [
    { name: 'withdraw supply', route: '/', ctaPattern: /^Withdraw$/i },
  ],
  notes: 'Compound v3 — simpler than Aave, one-borrowable-asset markets.',
};

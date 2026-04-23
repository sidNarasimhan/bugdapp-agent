import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const morphoProfile: DAppProfile = {
  name: 'Morpho',
  urlMatches: ['app.morpho.org'],
  url: 'https://app.morpho.org/',
  archetype: 'lending',
  network: NETWORKS.ethereum,
  values: { preferredAmountUsd: 5 },
  selectors: { navExcludeSelector: 'nav, header' },
  inverseFlows: [
    { name: 'withdraw supply', route: '/', ctaPattern: /^Withdraw$/i },
  ],
  notes: 'Morpho Blue — modern lending primitive. Also on Base.',
};

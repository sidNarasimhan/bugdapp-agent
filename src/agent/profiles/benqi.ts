import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const benqiProfile: DAppProfile = {
  name: 'Benqi',
  urlMatches: ['app.benqi.fi', 'benqi.fi'],
  url: 'https://app.benqi.fi/markets',
  archetype: 'lending',
  network: NETWORKS.avalanche,
  values: { preferredAmountUsd: 5 },
  selectors: { navExcludeSelector: 'nav, header' },
  inverseFlows: [
    { name: 'withdraw supply', route: '/markets', ctaPattern: /^Withdraw$/i },
  ],
  notes: 'Benqi lending on Avalanche. Also has liquid staking (sAVAX).',
};

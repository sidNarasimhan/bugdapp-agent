import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const venusProfile: DAppProfile = {
  name: 'Venus',
  urlMatches: ['app.venus.io', 'venus.io'],
  url: 'https://app.venus.io/',
  archetype: 'lending',
  network: NETWORKS.bnb,
  values: { preferredAmountUsd: 5 },
  selectors: { navExcludeSelector: 'nav, header' },
  inverseFlows: [
    { name: 'withdraw supply', route: '/', ctaPattern: /^Withdraw$/i },
  ],
  notes: 'Venus — biggest lending market on BNB Chain.',
};

import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const yearnProfile: DAppProfile = {
  name: 'Yearn',
  urlMatches: ['yearn.fi', 'yearn.finance'],
  url: 'https://yearn.fi/v3',
  archetype: 'yield',
  network: NETWORKS.ethereum,
  values: { preferredAmountUsd: 5 },
  selectors: { navExcludeSelector: 'nav, header' },
  notes: 'Yearn v3 vaults — auto-compounding yield aggregator.',
};

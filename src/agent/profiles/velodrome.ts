import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const velodromeProfile: DAppProfile = {
  name: 'Velodrome',
  urlMatches: ['velodrome.finance'],
  url: 'https://velodrome.finance/swap',
  archetype: 'swap',
  network: NETWORKS.optimism,
  values: { preferredAmountUsd: 1, slippageBps: 50 },
  selectors: { navExcludeSelector: 'nav, header' },
  notes: 'Velodrome V2 on Optimism. Same UI/UX as Aerodrome — one profile shape, two chains.',
};

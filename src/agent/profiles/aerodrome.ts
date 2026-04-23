import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const aerodromeProfile: DAppProfile = {
  name: 'Aerodrome',
  urlMatches: ['aerodrome.finance'],
  url: 'https://aerodrome.finance/swap',
  archetype: 'swap',
  network: NETWORKS.base,
  values: { preferredAmountUsd: 1, slippageBps: 50 },
  selectors: { navExcludeSelector: 'nav, header' },
  notes: 'Aerodrome is the Velodrome fork on Base — ve(3,3) DEX.',
};

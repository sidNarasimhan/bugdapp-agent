import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const quickswapProfile: DAppProfile = {
  name: 'QuickSwap',
  urlMatches: ['quickswap.exchange'],
  url: 'https://quickswap.exchange/#/swap',
  archetype: 'swap',
  network: NETWORKS.polygon,
  values: { preferredAmountUsd: 1, slippageBps: 50 },
  selectors: { navExcludeSelector: 'nav, header' },
  notes: 'QuickSwap v3 on Polygon. Uniswap v3 fork.',
};

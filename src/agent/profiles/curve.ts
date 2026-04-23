import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const curveProfile: DAppProfile = {
  name: 'Curve',
  urlMatches: ['curve.fi', 'www.curve.fi'],
  url: 'https://curve.fi/#/ethereum/swap',
  archetype: 'swap',
  network: NETWORKS.ethereum,
  values: { preferredAmountUsd: 1, slippageBps: 50 },
  selectors: { navExcludeSelector: 'nav, header' },
  notes: 'Curve stableswap DEX. Multi-chain — URL path selects chain.',
};

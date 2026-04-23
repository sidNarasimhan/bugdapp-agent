import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const balancerProfile: DAppProfile = {
  name: 'Balancer',
  urlMatches: ['balancer.fi', 'app.balancer.fi'],
  url: 'https://balancer.fi/swap/ethereum',
  archetype: 'swap',
  network: NETWORKS.ethereum,
  values: { preferredAmountUsd: 1, slippageBps: 50 },
  selectors: { navExcludeSelector: 'nav, header' },
  notes: 'Balancer weighted-pool DEX. Also liquidity pool management (LP archetype).',
};

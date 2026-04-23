import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const pancakeswapProfile: DAppProfile = {
  name: 'PancakeSwap',
  urlMatches: ['pancakeswap.finance'],
  url: 'https://pancakeswap.finance/swap',
  archetype: 'swap',
  network: NETWORKS.bnb,
  values: { preferredAmountUsd: 1, slippageBps: 50 },
  selectors: { navExcludeSelector: 'nav, header' },
  notes: 'PancakeSwap v3 on BNB Chain. Also deployed on Ethereum, Base, Arbitrum.',
};

import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const traderJoeProfile: DAppProfile = {
  name: 'Trader Joe',
  urlMatches: ['lfj.gg', 'traderjoexyz.com'],
  url: 'https://lfj.gg/avalanche/trade',
  archetype: 'swap',
  network: NETWORKS.avalanche,
  values: { preferredAmountUsd: 1, slippageBps: 50 },
  selectors: { navExcludeSelector: 'nav, header' },
  notes: 'Trader Joe (rebranded LFJ) on Avalanche. Also on Arbitrum, BNB.',
};

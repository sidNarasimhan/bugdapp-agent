import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const lidoProfile: DAppProfile = {
  name: 'Lido',
  urlMatches: ['stake.lido.fi'],
  url: 'https://stake.lido.fi/',
  archetype: 'staking',
  network: NETWORKS.ethereum,
  values: { preferredAmountUsd: 10 },
  selectors: { navExcludeSelector: 'nav, header' },
  inverseFlows: [
    {
      name: 'unstake',
      route: '/withdrawals/request',
      ctaPattern: /^(Unstake|Request withdrawal)$/i,
    },
  ],
  notes: 'Lido ETH liquid staking. stETH is the receipt. Unstake is a separate page.',
};

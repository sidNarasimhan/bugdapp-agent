import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const gmxProfile: DAppProfile = {
  name: 'GMX',
  urlMatches: ['app.gmx.io', /(?:^|\.)gmx\.io/],
  url: 'https://app.gmx.io/#/trade',
  archetype: 'perps',
  network: NETWORKS.arbitrum,
  values: {
    minPositionSizeUsd: 11, // GMX has $10 min position size + slippage buffer
    targetLeverage: 10,
    preferredAmountUsd: 5,
  },
  selectors: {
    navExcludeSelector: 'nav, header, [class*="navbar" i]',
  },
  inverseFlows: [
    {
      name: 'close position',
      route: '/#/trade',
      ctaPattern: /^Close$/i,
      confirmPattern: /^(Close|Confirm)$/i,
    },
  ],
  notes: 'GMX v2 on Arbitrum. Supports spot + perps. Long/Short toggle, leverage slider.',
};

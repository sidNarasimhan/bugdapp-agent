import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const vertexProfile: DAppProfile = {
  name: 'Vertex',
  urlMatches: ['app.vertexprotocol.com', /(?:^|\.)vertexprotocol\.com/],
  url: 'https://app.vertexprotocol.com/trade',
  archetype: 'perps',
  network: NETWORKS.arbitrum,
  values: {
    minPositionSizeUsd: 10,
    targetLeverage: 10,
    preferredAmountUsd: 5,
  },
  selectors: { navExcludeSelector: 'nav, header' },
  inverseFlows: [
    { name: 'close position', route: '/portfolio', ctaPattern: /^Close$/i },
  ],
  notes: 'Vertex orderbook + AMM hybrid perps on Arbitrum.',
};

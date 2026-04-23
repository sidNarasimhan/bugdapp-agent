import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const pendleProfile: DAppProfile = {
  name: 'Pendle',
  urlMatches: ['app.pendle.finance'],
  url: 'https://app.pendle.finance/trade/markets',
  archetype: 'yield',
  network: NETWORKS.ethereum,
  values: { preferredAmountUsd: 5 },
  selectors: { navExcludeSelector: 'nav, header' },
  notes: 'Pendle yield trading — split assets into PT (principal) + YT (yield). Multi-chain.',
};

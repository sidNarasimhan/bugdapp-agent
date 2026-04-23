import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const aaveProfile: DAppProfile = {
  name: 'Aave',
  urlMatches: ['app.aave.com', /(?:^|\.)aave\.com/],
  // Target the Base deployment — matches the marketName=proto_base_v3 URL param
  // we use across crawl + test runs. Base has cheaper gas + the same Aave V3
  // contracts as Ethereum, so flows are identical.
  url: 'https://app.aave.com/?marketName=proto_base_v3',
  archetype: 'lending',
  network: NETWORKS.base,
  values: { preferredAmountUsd: 5 },
  selectors: {
    navExcludeSelector: 'nav, header, [class*="navbar" i]',
    connect: {
      // Aave uses web3modal with direct wallet list — MM is usually top-of-list.
    },
  },
  inverseFlows: [
    {
      name: 'withdraw supply',
      route: '/',
      ctaPattern: /^Withdraw$/i,
      confirmPattern: /^(Confirm|Confirm Withdraw)$/i,
    },
  ],
  notes: 'Aave v3 on Ethereum. Market selector in header (Ethereum/Base/Arbitrum/etc).',
};

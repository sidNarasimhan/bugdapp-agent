import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const skyProfile: DAppProfile = {
  name: 'Sky',
  urlMatches: ['app.sky.money', 'sky.money'],
  url: 'https://app.sky.money/',
  archetype: 'cdp',
  network: NETWORKS.ethereum,
  values: { preferredAmountUsd: 50 }, // Sky mints USDS — reasonable collateral floor
  selectors: { navExcludeSelector: 'nav, header' },
  notes: 'Sky (formerly MakerDAO). Vault-based CDP, mints USDS stablecoin. Rewards for staking.',
};

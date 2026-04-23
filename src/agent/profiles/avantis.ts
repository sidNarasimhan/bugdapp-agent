/**
 * Avantis — perpetual DEX on Base.
 * Auth: Privy embedded wallet (social + EVM), MetaMask is the EVM path
 * Collateral: USDC only
 * Min position size: $500 (per-asset; a doc-extracted default, can vary)
 * Max leverage: 500x crypto, 250x ZFP scope, 50x forex
 */
import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const avantisProfile: DAppProfile = {
  name: 'Avantis',
  urlMatches: ['developer.avantisfi.com', 'avantisfi.com', /(?:^|\.)avantisfi\.com/],
  url: 'https://developer.avantisfi.com/trade',
  archetype: 'perps',
  network: NETWORKS.base,

  values: {
    minPositionSizeUsd: 500,
    // Avantis risk engine flags "leverage too high" when margin-after-fees is too thin.
    // 25x on $25 collateral gives a comfortable $625 position with enough margin buffer.
    // Increase only after verifying the risk engine accepts it.
    targetLeverage: 25,
    preferredAmountUsd: 25,
  },

  selectors: {
    // Avantis top nav has a "Trade" <a role=button>, which a naive regex grabs as .first().
    // We tell the spec-generator to look for CTAs *outside* the nav.
    navExcludeSelector: 'nav, header, [class*="navbar" i]',
    // Token/asset selector opens a modal; Avantis shows "BTCUSD"-style button to open it.
    assetSelectorPattern: /^[A-Z]{3,}[-/]?USD$/i,
  },

  inverseFlows: [
    {
      name: 'close position',
      route: '/portfolio',
      ctaPattern: /^Close$|Close Position|Market Close/i,
      confirmPattern: /^(Close|Confirm|Close Position|Close Trade)$/i,
    },
  ],

  notes:
    'Privy wraps MetaMask via "Continue with a wallet → MetaMask" button sequence. ' +
    'ZFP (Zero Fee Perps) requires >=75x leverage and market orders only. ' +
    'Smart Wallet (Gelato gasless) is opt-in; tests can submit directly via MM signing.',
};

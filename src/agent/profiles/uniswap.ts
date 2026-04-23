/**
 * Uniswap — AMM DEX. Primary surface: app.uniswap.org (multi-chain, but default Ethereum).
 *
 * Shape: fromToken → toToken → amount → (Approve) → Swap.
 * No deposit/bootstrap step; wallet balance IS the trading balance.
 */
import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const uniswapProfile: DAppProfile = {
  name: 'Uniswap',
  urlMatches: ['app.uniswap.org', /(?:^|\.)uniswap\.org/],
  // Run on Base — our test wallet is funded there with USDC + cheap gas. The swap form is
  // identical to Ethereum mainnet; only the RPC and default token pair change.
  url: 'https://app.uniswap.org/swap?chain=base',
  archetype: 'swap',
  network: NETWORKS.base,

  values: {
    // Small swap — 1 unit of the input token (which is whatever the crawler picks as default).
    preferredAmountUsd: 1,
    slippageBps: 50, // 0.5%
  },

  selectors: {
    navExcludeSelector: 'nav, header, [class*="navbar" i], [class*="header" i]',
    connect: {
      // Uniswap's wallet modal hides MetaMask behind an "Other wallets" expander —
      // top-level options are Uniswap Wallet, WalletConnect, Coinbase, Binance.
      preMetaMaskClicks: [/^Other wallets$/i, /^More wallets$/i],
      loginButtonTestId: 'navbar-connect-wallet',
    },
  },

  inverseFlows: [
    // Uniswap swaps don't have a single-click inverse — an "inverse" swap is just another swap
    // in the reverse direction. The spec-generator can't auto-generate this without asset info.
    // TODO: emit a reverse-direction swap as a paired test when KG has both tokens identified.
  ],

  notes:
    'Uniswap Interface uses RainbowKit/Wagmi. Connect button label is "Connect" (no Privy wrapper). ' +
    'Swap CTA can be "Swap", "Review Swap", or "Confirm Swap" depending on the flow stage. ' +
    'ERC20 approval is a separate tx before the first swap of a given token.',
};

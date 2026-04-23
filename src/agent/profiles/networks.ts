/**
 * Shared network configurations for all supported EVM chains.
 * Each profile references the network by chain name; no profile redefines RPC URLs.
 */
import type { NetworkConfig, Chain } from './types.js';

const commonSwitchCta = /Switch to|Wrong Network|Unsupported Network|Change Network/i;

export const NETWORKS: Record<Chain, NetworkConfig> = {
  ethereum: {
    chain: 'ethereum',
    chainId: 1,
    chainHexId: '0x1',
    rpcUrl: 'https://eth.llamarpc.com',
    blockExplorerUrl: 'https://etherscan.io',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    switchCtaPattern: commonSwitchCta,
  },
  base: {
    chain: 'base',
    chainId: 8453,
    chainHexId: '0x2105',
    rpcUrl: 'https://mainnet.base.org',
    blockExplorerUrl: 'https://basescan.org',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    switchCtaPattern: commonSwitchCta,
  },
  arbitrum: {
    chain: 'arbitrum',
    chainId: 42161,
    chainHexId: '0xa4b1',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    blockExplorerUrl: 'https://arbiscan.io',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    switchCtaPattern: commonSwitchCta,
  },
  optimism: {
    chain: 'optimism',
    chainId: 10,
    chainHexId: '0xa',
    rpcUrl: 'https://mainnet.optimism.io',
    blockExplorerUrl: 'https://optimistic.etherscan.io',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    switchCtaPattern: commonSwitchCta,
  },
  polygon: {
    chain: 'polygon',
    chainId: 137,
    chainHexId: '0x89',
    rpcUrl: 'https://polygon-rpc.com',
    blockExplorerUrl: 'https://polygonscan.com',
    nativeCurrency: { symbol: 'MATIC', decimals: 18 },
    switchCtaPattern: commonSwitchCta,
  },
  bnb: {
    chain: 'bnb',
    chainId: 56,
    chainHexId: '0x38',
    rpcUrl: 'https://bsc-dataseed.binance.org',
    blockExplorerUrl: 'https://bscscan.com',
    nativeCurrency: { symbol: 'BNB', decimals: 18 },
    switchCtaPattern: commonSwitchCta,
  },
  avalanche: {
    chain: 'avalanche',
    chainId: 43114,
    chainHexId: '0xa86a',
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    blockExplorerUrl: 'https://snowtrace.io',
    nativeCurrency: { symbol: 'AVAX', decimals: 18 },
    switchCtaPattern: commonSwitchCta,
  },
  linea: {
    chain: 'linea',
    chainId: 59144,
    chainHexId: '0xe708',
    rpcUrl: 'https://rpc.linea.build',
    blockExplorerUrl: 'https://lineascan.build',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    switchCtaPattern: commonSwitchCta,
  },
  blast: {
    chain: 'blast',
    chainId: 81457,
    chainHexId: '0x13e31',
    rpcUrl: 'https://rpc.blast.io',
    blockExplorerUrl: 'https://blastscan.io',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    switchCtaPattern: commonSwitchCta,
  },
  scroll: {
    chain: 'scroll',
    chainId: 534352,
    chainHexId: '0x82750',
    rpcUrl: 'https://rpc.scroll.io',
    blockExplorerUrl: 'https://scrollscan.com',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    switchCtaPattern: commonSwitchCta,
  },
};

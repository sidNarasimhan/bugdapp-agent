/**
 * Chain catalogue — the minimum set we need to talk to every dApp we model.
 *
 * We deliberately do not import viem's built-in chain definitions and use them
 * directly, because we want:
 *   - explicit RPC URLs that can be overridden by env for local Anvil forks,
 *   - block explorer API endpoints for ABI fetching,
 *   - a default public RPC that works without an Alchemy/Infura key.
 *
 * If the user sets $CHAIN_RPC_<chainId> in the environment, that wins over the
 * default public RPC — this is how Anvil fork routing is wired in Phase 3.
 */
import { createPublicClient, http, type Chain, type PublicClient } from 'viem';
import {
  mainnet, base, arbitrum, optimism, polygon, bsc, avalanche, linea, blast, scroll,
} from 'viem/chains';

export interface ChainEntry {
  chain: Chain;
  /** Human slug (matches profile network chain field). */
  slug: string;
  /** Fallback public RPC — used when no env override is set. */
  defaultRpc: string;
  /** Block explorer API root used by abi-registry.ts for contract lookups. */
  explorerApi: string;
  /** Etherscan-family v2 unified API uses a single host with chainid parameter. */
  explorerV2: boolean;
}

export const CHAINS: Record<number, ChainEntry> = {
  1:     { chain: mainnet,   slug: 'ethereum',  defaultRpc: 'https://eth.llamarpc.com',         explorerApi: 'https://api.etherscan.io/v2/api',     explorerV2: true },
  8453:  { chain: base,      slug: 'base',      defaultRpc: 'https://mainnet.base.org',         explorerApi: 'https://api.etherscan.io/v2/api',     explorerV2: true },
  42161: { chain: arbitrum,  slug: 'arbitrum',  defaultRpc: 'https://arb1.arbitrum.io/rpc',     explorerApi: 'https://api.etherscan.io/v2/api',     explorerV2: true },
  10:    { chain: optimism,  slug: 'optimism',  defaultRpc: 'https://mainnet.optimism.io',      explorerApi: 'https://api.etherscan.io/v2/api',     explorerV2: true },
  137:   { chain: polygon,   slug: 'polygon',   defaultRpc: 'https://polygon-rpc.com',          explorerApi: 'https://api.etherscan.io/v2/api',     explorerV2: true },
  56:    { chain: bsc,       slug: 'bnb',       defaultRpc: 'https://bsc-dataseed.binance.org', explorerApi: 'https://api.etherscan.io/v2/api',     explorerV2: true },
  43114: { chain: avalanche, slug: 'avalanche', defaultRpc: 'https://api.avax.network/ext/bc/C/rpc', explorerApi: 'https://api.etherscan.io/v2/api', explorerV2: true },
  59144: { chain: linea,     slug: 'linea',     defaultRpc: 'https://rpc.linea.build',          explorerApi: 'https://api.etherscan.io/v2/api',     explorerV2: true },
  81457: { chain: blast,     slug: 'blast',     defaultRpc: 'https://rpc.blast.io',             explorerApi: 'https://api.etherscan.io/v2/api',     explorerV2: true },
  534352:{ chain: scroll,    slug: 'scroll',    defaultRpc: 'https://rpc.scroll.io',            explorerApi: 'https://api.etherscan.io/v2/api',     explorerV2: true },
};

/** Look up a chain entry by id. Throws if we don't model this chain yet. */
export function getChainEntry(chainId: number): ChainEntry {
  const entry = CHAINS[chainId];
  if (!entry) throw new Error(`chain ${chainId} not in catalogue — add it to src/agent/chain/chains.ts`);
  return entry;
}

/** Resolve the RPC URL for a chain, honouring per-chain env overrides for Anvil forks. */
export function resolveRpcUrl(chainId: number): string {
  const entry = getChainEntry(chainId);
  const envKey = `CHAIN_RPC_${chainId}`;
  return process.env[envKey] || entry.defaultRpc;
}

/** Clients are cached per-chainId — creating one is cheap but we avoid the churn in hot paths. */
const clientCache = new Map<number, PublicClient>();

export function getPublicClient(chainId: number): PublicClient {
  const cached = clientCache.get(chainId);
  if (cached) return cached;
  const entry = getChainEntry(chainId);
  const client = createPublicClient({
    chain: entry.chain,
    transport: http(resolveRpcUrl(chainId), { timeout: 15_000, retryCount: 2 }),
  });
  clientCache.set(chainId, client);
  return client;
}

/** Force-invalidate the client cache. Used after rewiring to an Anvil fork mid-session. */
export function resetClientCache() {
  clientCache.clear();
}

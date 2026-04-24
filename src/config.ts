/**
 * Active dApp configuration.
 *
 * The agent's knowledge about a dApp lives in output/<host>/{comprehension,
 * knowledge-graph}.json (produced by the pipeline). This module resolves
 * runtime identity from those artifacts + viem's chain registry.
 *
 * Environment:
 *   DAPP_URL   override the active dApp URL (default: Avantis)
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  base, mainnet, arbitrum, optimism, polygon, bsc, avalanche, linea, blast, scroll,
  type Chain,
} from 'viem/chains';
import type { ArchetypeName, ValueConfig } from './types.js';

const DEFAULT_URL = 'https://developer.avantisfi.com/trade';

export interface ActiveDApp {
  name: string;
  url: string;
  archetype: string;
  chain: Chain;
  hostDir: string;
}

/**
 * Back-compat shape consumed by the legacy spec-generator. New code should
 * use ActiveDApp + the knowledge-loader instead. This is assembled on demand
 * from comprehension + viem chain so no per-dApp file is maintained.
 */
export interface DAppProfile {
  name: string;
  url: string;
  archetype: ArchetypeName;
  values: ValueConfig;
  network: {
    chain: string;
    chainId: number;
    chainHexId: string;
    rpcUrl: string;
    blockExplorerUrl: string;
    nativeCurrency: { symbol: string; decimals: number };
    switchCtaPattern: RegExp;
  };
  selectors?: {
    connect?: {
      preMetaMaskClicks?: Array<string | RegExp>;
      loginButtonPattern?: RegExp;
      loginButtonTestId?: string;
    };
    navExcludeSelector?: string;
    assetSelectorPattern?: RegExp;
    ctaTiers?: RegExp[];
    formPanelSelector?: string;
  };
  inverseFlows?: Array<{ name: string; route: string; ctaPattern: RegExp; confirmPattern?: RegExp }>;
  notes?: string;
}

const CHAIN_BY_ID: Record<number, Chain> = {
  1: mainnet, 10: optimism, 56: bsc, 137: polygon, 8453: base,
  42161: arbitrum, 43114: avalanche, 59144: linea, 81457: blast, 534352: scroll,
};

const CHAIN_BY_NAME: Record<string, Chain> = {
  ethereum: mainnet, mainnet,
  base, arbitrum, optimism, polygon, bsc, avalanche, linea, blast, scroll,
  'op mainnet': optimism,
  'bnb': bsc, 'bnb smart chain': bsc, 'binance smart chain': bsc,
};

function hostDirFromUrl(url: string): string {
  try { return new URL(url).hostname.replace(/\./g, '-'); } catch { return url; }
}

function loadComprehension(hostSlug: string): any | null {
  const p = join(process.cwd(), 'output', hostSlug, 'comprehension.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

export function activeDApp(): ActiveDApp {
  const url = process.env.DAPP_URL ?? DEFAULT_URL;
  const host = hostDirFromUrl(url);
  const comp = loadComprehension(host);

  let chain: Chain = base;
  if (comp?.chains?.length) {
    const name = String(comp.chains[0]).toLowerCase();
    chain = CHAIN_BY_NAME[name] ?? base;
  }
  if (comp?.chainId && CHAIN_BY_ID[comp.chainId]) {
    chain = CHAIN_BY_ID[comp.chainId];
  }

  return {
    name: comp?.dappName ?? (() => { try { return new URL(url).hostname; } catch { return 'unknown'; } })(),
    url,
    archetype: comp?.archetype ?? 'unknown',
    chain,
    hostDir: host,
  };
}

export function outputDir(dapp: ActiveDApp = activeDApp()): string {
  return join(process.cwd(), 'output', dapp.hostDir);
}

/**
 * Legacy DAppProfile shim for spec-generator. Assembled on demand.
 * Values come from comprehension.json; hand-maintained constants avoided.
 */
export function getProfileOrThrow(url: string): DAppProfile {
  const host = hostDirFromUrl(url);
  const comp = loadComprehension(host);
  if (!comp) {
    throw new Error(`No comprehension.json at output/${host}/ — run the pipeline first to build the dApp brain.`);
  }
  const chainName = comp.chains?.[0] ?? 'base';
  const chain = CHAIN_BY_NAME[String(chainName).toLowerCase()] ?? base;

  // Pull min-position + leverage hints out of comprehension constraints (best effort).
  let minPosition: number | undefined;
  let targetLeverage: number | null = null;
  for (const c of comp.constraints ?? []) {
    const v = String(c?.value ?? '');
    const n = String(c?.name ?? '').toLowerCase();
    if (/min.*leverage|minimum.*leverage/.test(n)) {
      const m = v.match(/(\d+)/); if (m) targetLeverage = Number(m[1]);
    }
    if (/min.*position|minimum.*position/.test(n)) {
      const m = v.match(/\$?(\d+(?:\.\d+)?)/); if (m) minPosition = Number(m[1]);
    }
  }

  const archetype = (comp.archetype ?? 'perps') as ArchetypeName;
  return {
    name: comp.dappName ?? host,
    url,
    archetype,
    values: {
      minPositionSizeUsd: minPosition,
      targetLeverage,
      preferredAmountUsd: minPosition && targetLeverage ? Math.max(1, Math.ceil(minPosition / targetLeverage)) : 1,
    },
    network: {
      chain: chain.name.toLowerCase(),
      chainId: chain.id,
      chainHexId: '0x' + chain.id.toString(16),
      rpcUrl: chain.rpcUrls.default.http[0],
      blockExplorerUrl: chain.blockExplorers?.default.url ?? '',
      nativeCurrency: { symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals },
      switchCtaPattern: new RegExp(`Switch to ${chain.name}|Switch Network|Wrong Network`, 'i'),
    },
    notes: comp.summary,
  };
}

/** For heal-runner: resolve a profile from URL (ActiveDApp if DAPP_URL, else built from URL). */
export function findProfile(url: string): DAppProfile | null {
  try { return getProfileOrThrow(url); } catch { return null; }
}

/** Avantis profile object — named export for handler convenience. */
export const avantisProfile = {
  get name() { return activeDApp().name; },
  get url() { return activeDApp().url; },
  get archetype() { return activeDApp().archetype; },
};

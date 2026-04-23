/**
 * Contract address extractor — deterministic, no LLM.
 *
 * Inputs: docs text + raw API response bodies + optional bundle text.
 * Outputs: deduplicated KGContract[] with role-tagging heuristics.
 *
 * Role inference is best-effort from surrounding text: `router`, `factory`,
 * `pool`, `token`, `oracle`, `vault`, `lending` etc. If we can't tell, we mark
 * it `other` so the downstream LLM / test-planner can reason over it anyway.
 *
 * If ETHERSCAN_API_KEY is set AND a chainId is known, we optionally verify the
 * contract (single HTTP call per address) to pick up the proper contract name
 * and the verified flag. Verification failures don't discard the address — we
 * keep it unverified.
 */

import type { KGContract } from '../state.js';

const ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/g;

// Common ERC addresses that show up in every dApp's bundle/network traffic
// but aren't dApp-specific (null address, permit2, EntryPoint, common tokens
// we don't want to spam into the graph — unless the dApp is specifically
// about them, which is detected elsewhere).
const SKIP_ADDRESSES = new Set<string>([
  '0x0000000000000000000000000000000000000000', // null
  '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
  '0x0000000071727de22e5e9d8baf0edac6f37da032', // EntryPoint v0.7
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', // EntryPoint v0.6
]);

interface RoleHint {
  /** Regex that must match the keyword near the address. */
  keyword: RegExp;
  role: string;
}

const ROLE_HINTS: RoleHint[] = [
  { keyword: /\brouter\b/i, role: 'router' },
  { keyword: /\bfactory\b/i, role: 'factory' },
  { keyword: /\bpool(?:\s*manager)?\b/i, role: 'pool' },
  { keyword: /\boracle\b|\bprice\s*feed\b/i, role: 'oracle' },
  { keyword: /\bvault\b/i, role: 'vault' },
  { keyword: /\baave|comet|compound|morpho|lending|borrow|supply/i, role: 'lending' },
  { keyword: /\bstak(?:e|ing)\b|\bvalidator\b/i, role: 'staking' },
  { keyword: /\bperp|trading|margin\b/i, role: 'perps' },
  { keyword: /\btoken|ERC20|USDC|WETH|DAI\b/i, role: 'token' },
  { keyword: /\bbridge\b/i, role: 'bridge' },
  { keyword: /\bgovern|DAO|vote|proposal/i, role: 'governance' },
];

/**
 * Scan text (docs, bundle, API body) for 0x{40} addresses.
 * Returns a map of address → role guesses (from surrounding context).
 */
function findAddressesInText(text: string, source: KGContract['source']): Map<string, { sources: Set<KGContract['source']>; roleHints: Set<string> }> {
  const found = new Map<string, { sources: Set<KGContract['source']>; roleHints: Set<string> }>();
  if (!text) return found;

  const matches = [...text.matchAll(ADDRESS_RE)];
  for (const m of matches) {
    const addr = m[0].toLowerCase();
    if (SKIP_ADDRESSES.has(addr)) continue;

    // Grab ~80 chars of surrounding context for role inference.
    const idx = m.index ?? 0;
    const ctx = text.slice(Math.max(0, idx - 80), idx + 120);

    const entry = found.get(addr) ?? { sources: new Set<KGContract['source']>(), roleHints: new Set<string>() };
    entry.sources.add(source);
    for (const hint of ROLE_HINTS) {
      if (hint.keyword.test(ctx)) entry.roleHints.add(hint.role);
    }
    found.set(addr, entry);
  }
  return found;
}

/**
 * Recursively walk a captured API body, collecting all string values that
 * match the address regex. API payloads often have addresses in nested keys
 * (e.g. `data.pools[0].token0.address`), and those addresses typically
 * represent tokens or pools by role of the endpoint.
 */
function findAddressesInApiBody(body: any, path: string, foundInto: Map<string, { sources: Set<KGContract['source']>; roleHints: Set<string> }>) {
  if (body == null) return;
  if (typeof body === 'string') {
    for (const [addr, hints] of findAddressesInText(body, 'network')) {
      const existing = foundInto.get(addr) ?? { sources: new Set<KGContract['source']>(), roleHints: new Set<string>() };
      hints.sources.forEach(s => existing.sources.add(s));
      hints.roleHints.forEach(r => existing.roleHints.add(r));
      // Also infer role from the API endpoint path — it often says `/pools`, `/tokens`.
      for (const hint of ROLE_HINTS) {
        if (hint.keyword.test(path)) existing.roleHints.add(hint.role);
      }
      foundInto.set(addr, existing);
    }
    return;
  }
  if (typeof body !== 'object') return;
  if (Array.isArray(body)) {
    for (const item of body) findAddressesInApiBody(item, path, foundInto);
    return;
  }
  for (const [k, v] of Object.entries(body)) {
    // Treat the key as a role hint when the value is an address.
    if (typeof v === 'string' && ADDRESS_RE.test(v.toLowerCase())) {
      ADDRESS_RE.lastIndex = 0; // reset regex state
      const addr = v.toLowerCase();
      if (!SKIP_ADDRESSES.has(addr)) {
        const existing = foundInto.get(addr) ?? { sources: new Set<KGContract['source']>(), roleHints: new Set<string>() };
        existing.sources.add('network');
        for (const hint of ROLE_HINTS) {
          if (hint.keyword.test(k) || hint.keyword.test(path)) existing.roleHints.add(hint.role);
        }
        foundInto.set(addr, existing);
      }
    } else {
      findAddressesInApiBody(v, path + '.' + k, foundInto);
    }
  }
  ADDRESS_RE.lastIndex = 0;
}

export interface ExtractContractsOptions {
  docsContent?: string;
  rawApiData?: Record<string, any>;
  bundleText?: string;
  /** If known, attach this chainId to every found contract. */
  defaultChainId?: number;
}

/**
 * Main entry point. Produces the deterministic KGContract[] from available
 * sources. Does NOT make network calls — Etherscan verification is a separate
 * step (see `verifyContractsViaEtherscan` below) that callers can opt into.
 */
export function extractContracts(opts: ExtractContractsOptions): KGContract[] {
  const all = new Map<string, { sources: Set<KGContract['source']>; roleHints: Set<string> }>();

  if (opts.docsContent) {
    for (const [addr, hints] of findAddressesInText(opts.docsContent, 'docs')) {
      const existing = all.get(addr) ?? { sources: new Set<KGContract['source']>(), roleHints: new Set<string>() };
      hints.sources.forEach(s => existing.sources.add(s));
      hints.roleHints.forEach(r => existing.roleHints.add(r));
      all.set(addr, existing);
    }
  }

  if (opts.rawApiData) {
    for (const [path, body] of Object.entries(opts.rawApiData)) {
      findAddressesInApiBody(body, path, all);
    }
  }

  if (opts.bundleText) {
    for (const [addr, hints] of findAddressesInText(opts.bundleText, 'bundle')) {
      const existing = all.get(addr) ?? { sources: new Set<KGContract['source']>(), roleHints: new Set<string>() };
      hints.sources.forEach(s => existing.sources.add(s));
      hints.roleHints.forEach(r => existing.roleHints.add(r));
      all.set(addr, existing);
    }
  }

  const out: KGContract[] = [];
  for (const [addr, info] of all) {
    // Pick the first role hint; if multiple, the most specific (longest name) wins.
    const role = [...info.roleHints].sort((a, b) => b.length - a.length)[0];
    // Primary source = first in priority order: network > docs > bundle.
    const source: KGContract['source'] = info.sources.has('network')
      ? 'network'
      : info.sources.has('docs') ? 'docs' : 'bundle';

    out.push({
      id: `contract:${addr}`,
      address: addr,
      chainId: opts.defaultChainId,
      role: role ?? 'other',
      source,
    });
  }

  // Sort by role priority for readability: routers, pools, lending, perps first.
  const rolePriority: Record<string, number> = {
    router: 0, factory: 1, pool: 2, lending: 3, perps: 4, vault: 5, oracle: 6,
    staking: 7, bridge: 8, governance: 9, token: 10, other: 99,
  };
  out.sort((a, b) => (rolePriority[a.role ?? 'other'] ?? 99) - (rolePriority[b.role ?? 'other'] ?? 99));
  return out;
}

/**
 * Optional Etherscan V2 unified-API verification. Skipped if no API key is set.
 * Capped at 10 addresses per call to keep latency + cost in check. Never throws
 * — any per-address failure just leaves that contract unverified.
 */
export async function verifyContractsViaEtherscan(
  contracts: KGContract[],
  opts: { apiKey?: string; maxVerify?: number } = {},
): Promise<KGContract[]> {
  const apiKey = opts.apiKey ?? process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return contracts;
  const maxVerify = opts.maxVerify ?? 10;

  const toVerify = contracts.filter(c => c.chainId && !c.verified).slice(0, maxVerify);
  const updated = new Map(contracts.map(c => [c.id, c]));

  for (const c of toVerify) {
    try {
      const url = `https://api.etherscan.io/v2/api?chainid=${c.chainId}&module=contract&action=getsourcecode&address=${c.address}&apikey=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json() as any;
      const entry = Array.isArray(json?.result) ? json.result[0] : null;
      if (!entry) continue;
      const name = typeof entry.ContractName === 'string' && entry.ContractName.length > 0 ? entry.ContractName : undefined;
      const verified = typeof entry.SourceCode === 'string' && entry.SourceCode.length > 10;
      updated.set(c.id, { ...c, name, verified });
    } catch { /* keep unverified */ }
  }

  return [...updated.values()];
}

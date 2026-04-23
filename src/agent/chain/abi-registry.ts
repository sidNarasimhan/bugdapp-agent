/**
 * ABI registry — turns a (chainId, address) pair into a usable ABI for log decoding.
 *
 * Resolution order:
 *   1. In-memory bundled well-known ABIs (ERC20, ERC721, ERC1155, Uniswap V2/V3, Permit2).
 *      These match by bytecode fingerprint OR by convention — we don't need an explicit
 *      contract match for a Transfer log, any ERC20 ABI decodes it.
 *   2. Local disk cache at `data/abis/<chainId>/<address>.json`. Hit this on every subsequent
 *      decode, so a cold cache fetch only happens once per contract.
 *   3. Etherscan V2 unified API (https://api.etherscan.io/v2/api?chainid=X&...). One API key
 *      covers all supported chains. Requires $ETHERSCAN_API_KEY (falls through if absent).
 *   4. Sourcify public repo (no API key needed). Covers most verified contracts, slower.
 *
 * Anything this module returns is a parsed `Abi` suitable for viem's decodeEventLog.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Abi, Address } from 'viem';
import { parseAbi } from 'viem';

const ABI_CACHE_ROOT = join(process.cwd(), 'data', 'abis');

/** Fragment-only ABIs we use as a universal fallback decoder for common log shapes. */
export const COMMON_EVENT_ABI: Abi = parseAbi([
  // ERC20
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  // ERC721
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
  // Wrapped native
  'event Deposit(address indexed dst, uint256 wad)',
  'event Withdrawal(address indexed src, uint256 wad)',
  // UniV2 Pair
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
  // UniV3 Pool
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  // Aave V3 Pool
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
  'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
  // Permit2
  'event Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce)',
  // Generic perps trading (shape used by many clones — Avantis, Mux, Level)
  'event TradeOpened(address indexed trader, uint256 indexed tradeId, address collateralToken, uint256 collateral, uint256 leverage, bool isLong, uint256 openPrice)',
  'event TradeClosed(address indexed trader, uint256 indexed tradeId, uint256 closePrice, int256 pnl)',
]);

/** Known per-dApp contract ABIs. Shipped in-tree for dApps we model. */
const KNOWN_ABIS: Record<string, Abi> = {};

/**
 * Merge a caller-supplied ABI into the known registry. Lets profiles register their
 * dApp-specific ABIs at startup without touching this file.
 */
export function registerAbi(chainId: number, address: Address, abi: Abi): void {
  KNOWN_ABIS[`${chainId}:${address.toLowerCase()}`] = abi;
}

/**
 * Look up an ABI for (chainId, address). Hits the known registry, then disk cache,
 * then Etherscan V2, then Sourcify. Returns null if nothing resolves — the caller
 * should fall back to COMMON_EVENT_ABI for best-effort log decoding.
 */
export async function getAbi(chainId: number, address: Address): Promise<Abi | null> {
  const key = `${chainId}:${address.toLowerCase()}`;

  // 1. In-memory known ABIs.
  if (KNOWN_ABIS[key]) return KNOWN_ABIS[key];

  // 2. Disk cache.
  const cached = readDiskCache(chainId, address);
  if (cached) {
    KNOWN_ABIS[key] = cached;
    return cached;
  }

  // 3. Etherscan V2 unified API.
  const etherscanAbi = await fetchFromEtherscanV2(chainId, address).catch(() => null);
  if (etherscanAbi) {
    writeDiskCache(chainId, address, etherscanAbi);
    KNOWN_ABIS[key] = etherscanAbi;
    return etherscanAbi;
  }

  // 4. Sourcify fallback.
  const sourcifyAbi = await fetchFromSourcify(chainId, address).catch(() => null);
  if (sourcifyAbi) {
    writeDiskCache(chainId, address, sourcifyAbi);
    KNOWN_ABIS[key] = sourcifyAbi;
    return sourcifyAbi;
  }

  return null;
}

function readDiskCache(chainId: number, address: Address): Abi | null {
  const path = join(ABI_CACHE_ROOT, String(chainId), `${address.toLowerCase()}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Abi;
  } catch {
    return null;
  }
}

function writeDiskCache(chainId: number, address: Address, abi: Abi): void {
  const dir = join(ABI_CACHE_ROOT, String(chainId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${address.toLowerCase()}.json`), JSON.stringify(abi, null, 2));
}

async function fetchFromEtherscanV2(chainId: number, address: Address): Promise<Abi | null> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return null; // soft-fail: we don't require the key
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getabi&address=${address}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = await res.json() as { status: string; message: string; result: string };
  if (body.status !== '1' || !body.result || body.result.startsWith('Contract source code not verified')) return null;
  try {
    return JSON.parse(body.result) as Abi;
  } catch {
    return null;
  }
}

async function fetchFromSourcify(chainId: number, address: Address): Promise<Abi | null> {
  // Try full-match first (high confidence), then partial-match (best-effort).
  for (const match of ['full_match', 'partial_match']) {
    const url = `https://repo.sourcify.dev/contracts/${match}/${chainId}/${address}/metadata.json`;
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) continue;
    try {
      const meta = await res.json() as { output?: { abi?: Abi } };
      if (meta.output?.abi) return meta.output.abi;
    } catch {
      // keep trying the next match type
    }
  }
  return null;
}

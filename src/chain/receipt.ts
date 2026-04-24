/**
 * Receipt fetcher — resolves a captured tx hash into a decoded `VerifiedReceipt`.
 *
 * Handles:
 *   - Polling until the receipt appears (Anvil instant-mines, mainnet takes ~12s).
 *   - Decoding each log through abi-registry, falling back to COMMON_EVENT_ABI.
 *   - Surfacing "reverted" status without throwing, so callers can assert on it.
 */
import type { Hex, Abi, Log, Address } from 'viem';
import { decodeEventLog } from 'viem';
import { getPublicClient } from './chains.js';
import { getAbi, COMMON_EVENT_ABI } from './abi-registry.js';
import type { VerifiedReceipt, DecodedEvent } from './types.js';

export interface FetchReceiptOptions {
  /** How long to poll before giving up. Anvil is instant; live chains can take 60s on Base/Arb. */
  timeoutMs?: number;
  /** Poll interval. Default 1500ms matches viem's default. */
  pollIntervalMs?: number;
}

/**
 * Fetch + decode a receipt. Resolves even if the tx reverted — status is surfaced as
 * 'reverted' in the returned object. Only throws on actual network failure or timeout.
 */
export async function fetchAndDecodeReceipt(
  chainId: number,
  hash: Hex,
  opts: FetchReceiptOptions = {},
): Promise<VerifiedReceipt> {
  const client = getPublicClient(chainId);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: opts.timeoutMs ?? 120_000,
    pollingInterval: opts.pollIntervalMs ?? 1500,
    // viem returns the receipt regardless of success/revert — we want that.
    retryCount: 3,
  });

  // Resolve ABIs for every unique log address. Done in parallel — in the worst case
  // N addresses × one network round-trip, usually zero because most are cached.
  const uniqueAddresses = [...new Set(receipt.logs.map(l => l.address))] as Address[];
  const abiByAddress = new Map<Address, Abi | null>();
  await Promise.all(
    uniqueAddresses.map(async addr => {
      abiByAddress.set(addr, await getAbi(chainId, addr).catch(() => null));
    }),
  );

  const events: DecodedEvent[] = [];
  const rawLogs: Log[] = [];
  for (const log of receipt.logs) {
    const decoded = tryDecodeLog(log, abiByAddress.get(log.address as Address) ?? null);
    if (decoded) {
      events.push(decoded);
    } else {
      rawLogs.push(log);
    }
  }

  return {
    hash,
    chainId,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    from: receipt.from,
    to: receipt.to,
    status: receipt.status === 'success' ? 'success' : 'reverted',
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    events,
    rawLogs,
    raw: receipt,
  };
}

/**
 * Attempt to decode a log with the contract's own ABI first, then fall back to
 * COMMON_EVENT_ABI (which covers ERC20 Transfer, UniV2/V3 Swap, Aave Supply/Borrow/
 * Repay/Withdraw, WETH Deposit/Withdrawal, Permit2, and generic TradeOpened/Closed).
 * Returns null if neither source can decode the topic signature.
 */
function tryDecodeLog(log: Log, contractAbi: Abi | null): DecodedEvent | null {
  const candidates: Abi[] = [];
  if (contractAbi) candidates.push(contractAbi);
  candidates.push(COMMON_EVENT_ABI);

  for (const abi of candidates) {
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics,
        strict: false,
      });
      return {
        address: log.address as Address,
        name: decoded.eventName ?? 'unknown',
        args: toJsonSafe(decoded.args ?? {}) as Record<string, unknown>,
        logIndex: Number(log.logIndex ?? 0),
        raw: log,
      };
    } catch {
      // try next candidate ABI
    }
  }
  return null;
}

/** Recursively convert bigints to decimal strings so the event is JSON-serializable. */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

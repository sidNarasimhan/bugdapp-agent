/**
 * Anvil fork funding helpers — use Anvil's RPC cheats to give the test wallet
 * a usable balance without touching real money.
 *
 *   - anvil_setBalance: sets ETH balance directly, no whale needed.
 *   - anvil_setStorageAt: direct balance-mapping slot writes. Most reliable
 *     path for ERC20 funding — works for any token as long as we can find
 *     the balance mapping slot. Foundry's `deal()` uses the same trick.
 *   - anvil_impersonateAccount + eth_sendTransaction: optional fallback that
 *     spoofs a real whale when slot detection fails (e.g. unusual storage
 *     layouts).
 *
 * Slot detection: pick a known holder (any address with nonzero balance),
 * read their balance, then iterate candidate slots 0..MAX computing
 * keccak256(abi.encode(holder, slot)) and reading that storage cell. When the
 * stored value equals the balance, we've found the mapping slot. Cache it
 * per-(chainId, token) so subsequent calls are instant.
 */
import { createPublicClient, http, parseUnits, parseAbiItem, encodeAbiParameters, keccak256, toHex, pad, type Address, type Hex } from 'viem';

/** Anvil's default account #0 when started with --mnemonic "test test ... junk". */
export const ANVIL_ACCOUNT_0: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** Per-chain-per-token whale table. These addresses are stable, well-known holders. */
interface WhaleEntry {
  chainId: number;
  token: Address;
  symbol: string;
  whale: Address;
}

const WHALES: WhaleEntry[] = [
  // Base USDC (official Circle USDC on Base) — Coinbase hot wallet is a reliable whale.
  { chainId: 8453,  token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', whale: '0x21a9b0e03aebc78b3a6aa3a8d24b8f7eee9f0a0e' },
  // Ethereum USDC — Circle treasury is typical.
  { chainId: 1,     token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', whale: '0x55fe002aeff02f77364de339a1292923a15844b8' },
  // Arbitrum USDC (native, not bridged)
  { chainId: 42161, token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', whale: '0x489ee077994b6658eafa855c308275ead8097c4a' },
  // Optimism USDC (native)
  { chainId: 10,    token: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', symbol: 'USDC', whale: '0xacd03d601e5bb1b275bb94076ff46ed9d753435a' },
];

/** Register a custom whale at runtime — for profiles or scripts that need a token we don't ship. */
export function registerWhale(entry: WhaleEntry): void {
  WHALES.push(entry);
}

function findWhale(chainId: number, token: Address): WhaleEntry | undefined {
  return WHALES.find(w => w.chainId === chainId && w.token.toLowerCase() === token.toLowerCase());
}

/** Cache of resolved balance-mapping slots: `${chainId}:${token.toLowerCase()}` → slot number. */
const BALANCE_SLOT_CACHE = new Map<string, number>();

/**
 * Compute the storage key for `mapping(address => uint256).balances[holder]`
 * given the mapping's base slot. This is the Solidity storage layout rule:
 * slot = keccak256(abi.encode(holder, baseSlot)).
 */
function balanceStorageKey(holder: Address, slot: number): Hex {
  const encoded = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [holder, BigInt(slot)],
  );
  return keccak256(encoded);
}

/**
 * Find the balance-mapping slot for an ERC20 token by probing candidate slots
 * against a known holder. Tries common slots (0, 1, 2, 3, 9, 51) first, then
 * falls back to a linear scan 0..99. Caches the result. Uses the Anvil fork's
 * RPC so we're not rate-limited by public endpoints.
 */
async function findBalanceSlot(
  rpcUrl: string,
  token: Address,
  chainId: number,
): Promise<number | null> {
  const cacheKey = `${chainId}:${token.toLowerCase()}`;
  const cached = BALANCE_SLOT_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5000 }) });

  // Find a holder with nonzero balance. Grab a recent Transfer log from the
  // fork's backing state — any `from` or `to` in the last few blocks works.
  const latestBlock = await client.getBlockNumber();
  const fromBlock = latestBlock - 100n > 0n ? latestBlock - 100n : 0n;
  const logs = await client.getLogs({
    address: token,
    event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
    fromBlock,
    toBlock: latestBlock,
  }).catch(() => []);

  // Pick the first `to` that isn't the zero address.
  let holder: Address | null = null;
  for (const log of logs) {
    const to = log.args.to as Address | undefined;
    if (to && to !== '0x0000000000000000000000000000000000000000') {
      holder = to;
      break;
    }
  }
  if (!holder) return null;

  // Read the holder's balance via balanceOf()
  const balanceHex = await client.call({
    to: token,
    data: `0x70a08231${'0'.repeat(24)}${holder.slice(2).toLowerCase()}` as Hex,
  });
  const holderBalance = balanceHex?.data ? BigInt(balanceHex.data) : 0n;
  if (holderBalance === 0n) return null;

  // Probe: common slots first, then linear scan.
  const commonSlots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 51];
  const scanRange = Array.from({ length: 100 }, (_, i) => i).filter(s => !commonSlots.includes(s));
  const slotsToTry = [...commonSlots, ...scanRange];

  for (const slot of slotsToTry) {
    const key = balanceStorageKey(holder, slot);
    try {
      const stored = await rpc(rpcUrl, 'eth_getStorageAt', [token, key, 'latest']) as Hex;
      if (stored && stored !== '0x' && BigInt(stored) === holderBalance) {
        BALANCE_SLOT_CACHE.set(cacheKey, slot);
        return slot;
      }
    } catch {
      // slot read error — try next
    }
  }
  return null;
}

/**
 * Write a raw balance value to an ERC20's balance mapping for a given wallet.
 * Uses anvil_setStorageAt with the computed storage slot. Returns the slot
 * that was written, so callers can confirm + cache.
 */
async function writeBalanceSlot(
  rpcUrl: string,
  token: Address,
  wallet: Address,
  slot: number,
  rawBalance: bigint,
): Promise<void> {
  const key = balanceStorageKey(wallet, slot);
  const value = toHex(rawBalance, { size: 32 });
  await rpc(rpcUrl, 'anvil_setStorageAt', [token, key, value]);
}

/** Send an RPC call with automatic JSON decoding + error surfacing. */
async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method} error: ${body.error.message}`);
  return body.result;
}

/** Set a wallet's native ETH balance on a running Anvil fork, in human units (e.g. "10"). */
export async function setNativeBalance(rpcUrl: string, address: Address, eth: string): Promise<void> {
  const wei = parseUnits(eth, 18);
  await rpc(rpcUrl, 'anvil_setBalance', [address, `0x${wei.toString(16)}`]);
}

/**
 * Fund a wallet with ERC20 tokens on an Anvil fork by writing directly to the
 * token's balance-mapping storage slot. This is the most reliable approach —
 * works for any ERC20 regardless of whether we have a whale address, doesn't
 * require impersonation, doesn't leave a Transfer event on-chain (which can
 * matter for assertions that check "collateral transferred from wallet").
 *
 * Algorithm:
 *   1. Find the balance-mapping slot by probing candidate slots against a
 *      known holder's balance. Cached after first resolution.
 *   2. Write our desired balance to keccak256(abi.encode(wallet, slot)).
 *   3. Verify via balanceOf().
 *
 * Returns the resolved slot number for logging. Throws on failure so callers
 * know funding didn't happen (don't silent-fail a test that needs collateral).
 */
export async function fundErc20ViaSlot(
  rpcUrl: string,
  opts: { chainId: number; token: Address; to: Address; amount: string; decimals: number },
): Promise<{ slot: number; balance: bigint }> {
  const slot = await findBalanceSlot(rpcUrl, opts.token, opts.chainId);
  if (slot === null) {
    throw new Error(`could not locate balance-mapping slot for ${opts.token} on chain ${opts.chainId} — token may use a non-standard layout (Vyper, packed struct, etc.)`);
  }
  const rawBalance = parseUnits(opts.amount, opts.decimals);
  await writeBalanceSlot(rpcUrl, opts.token, opts.to, slot, rawBalance);

  // Verify via balanceOf()
  const balanceHex = await rpc(rpcUrl, 'eth_call', [
    { to: opts.token, data: `0x70a08231${'0'.repeat(24)}${opts.to.slice(2).toLowerCase()}` },
    'latest',
  ]) as Hex;
  const balance = balanceHex && balanceHex !== '0x' ? BigInt(balanceHex) : 0n;
  if (balance !== rawBalance) {
    throw new Error(`slot write succeeded but balanceOf returned ${balance} (expected ${rawBalance}) — wrong slot? try invalidating the cache`);
  }
  return { slot, balance };
}

/**
 * Legacy whale-impersonation path, kept as a fallback for the one-off case
 * where a token's storage layout defeats the slot finder (rare — Circle USDC,
 * DAI, WETH, and every OpenZeppelin ERC20 all work with the slot path).
 */
export async function fundErc20FromWhale(
  rpcUrl: string,
  opts: { chainId: number; token: Address; to: Address; amount: string; decimals: number },
): Promise<Hex> {
  const whaleEntry = findWhale(opts.chainId, opts.token);
  if (!whaleEntry) {
    throw new Error(
      `no whale registered for token ${opts.token} on chain ${opts.chainId} — prefer fundErc20ViaSlot() which does not need a whale table`,
    );
  }
  const amount = parseUnits(opts.amount, opts.decimals);
  await setNativeBalance(rpcUrl, whaleEntry.whale, '1');
  await rpc(rpcUrl, 'anvil_impersonateAccount', [whaleEntry.whale]);

  // ERC20 transfer selector: 0xa9059cbb + padded(to) + padded(amount)
  const transferData = ('0xa9059cbb' +
    opts.to.slice(2).toLowerCase().padStart(64, '0') +
    amount.toString(16).padStart(64, '0')) as Hex;

  const hash = await rpc(rpcUrl, 'eth_sendTransaction', [{
    from: whaleEntry.whale,
    to: opts.token,
    data: transferData,
    gas: '0x30d40',
  }]) as Hex;
  await rpc(rpcUrl, 'anvil_stopImpersonatingAccount', [whaleEntry.whale]);
  return hash;
}

/**
 * One-shot setup for a test wallet on an Anvil fork: gives it `eth` ETH and,
 * optionally, a list of ERC20 balances via whale impersonation. Returns a
 * summary of what was funded.
 */
export async function fundTestWallet(
  rpcUrl: string,
  opts: {
    chainId: number;
    wallet: Address;
    eth?: string;
    tokens?: Array<{ address: Address; amount: string; decimals: number; symbol?: string }>;
  },
): Promise<{ wallet: Address; eth: string; tokenResults: Array<{ symbol: string; ok: boolean; detail: string }> }> {
  const eth = opts.eth ?? '10';
  await setNativeBalance(rpcUrl, opts.wallet, eth);

  const tokenResults: Array<{ symbol: string; ok: boolean; detail: string }> = [];
  for (const t of opts.tokens ?? []) {
    const symbol = t.symbol ?? t.address;
    try {
      // Primary path: direct slot write. Works for 99% of ERC20s.
      const result = await fundErc20ViaSlot(rpcUrl, {
        chainId: opts.chainId,
        token: t.address,
        to: opts.wallet,
        amount: t.amount,
        decimals: t.decimals,
      });
      tokenResults.push({
        symbol, ok: true,
        detail: `slot ${result.slot}, balance ${result.balance}`,
      });
    } catch (slotErr: any) {
      // Fallback: whale impersonation, if the slot probe failed.
      try {
        const hash = await fundErc20FromWhale(rpcUrl, {
          chainId: opts.chainId, token: t.address, to: opts.wallet,
          amount: t.amount, decimals: t.decimals,
        });
        tokenResults.push({ symbol, ok: true, detail: `whale tx ${hash}` });
      } catch (whaleErr: any) {
        tokenResults.push({
          symbol, ok: false,
          detail: `slot: ${slotErr?.message ?? slotErr}; whale: ${whaleErr?.message ?? whaleErr}`,
        });
      }
    }
  }

  return { wallet: opts.wallet, eth, tokenResults };
}

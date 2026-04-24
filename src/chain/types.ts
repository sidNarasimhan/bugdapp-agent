/**
 * Shared types for the on-chain verification layer.
 *
 * The core flow:
 *   1. A Playwright test triggers a tx through MetaMask.
 *   2. tx-capture.ts intercepts the tx hash via an injected window.ethereum hook.
 *   3. receipt.ts fetches the receipt using viem against the right chain.
 *   4. decoder.ts decodes the logs using an ABI resolved through abi-registry.ts.
 *   5. assertions.ts runs archetype-specific + invariant-specific checks against
 *      the decoded events + post-tx chain state.
 *   6. On any assertion failure, findings.ts emits a shareable bundle.
 */
import type { Hex, Address, Log } from 'viem';

/**
 * Archetype name — string literal union, inlined to keep the chain module
 * self-contained when it's copied into `output/<dapp>/fixtures/chain/`. The
 * source of truth lives in `src/agent/profiles/types.ts`; this must stay in
 * sync. If you add an archetype there, add it here too.
 */
export type ArchetypeName = 'perps' | 'swap' | 'lending' | 'staking' | 'cdp' | 'yield' | 'lp' | 'bridge';

/** A tx hash captured during a Playwright test run, along with the chain it was submitted on. */
export interface CapturedTx {
  hash: Hex;
  chainId: number;
  /** Timestamp when the hash was observed in the page — client clock, not block time. */
  observedAt: number;
  /** Optional from-address hint extracted from the RPC request (not authoritative). */
  fromHint?: Address;
  /** The RPC method that surfaced the hash (eth_sendTransaction | eth_sendRawTransaction). */
  method: 'eth_sendTransaction' | 'eth_sendRawTransaction';
}

/** A decoded event extracted from a receipt log by the decoder. */
export interface DecodedEvent {
  address: Address;
  /** The event name as defined in the ABI (e.g. "Transfer", "TradeOpened"). */
  name: string;
  /** Named args as decoded. Values are left as JSON-serializable strings where bigint is involved. */
  args: Record<string, unknown>;
  /** Source log index within the receipt. */
  logIndex: number;
  /** The raw log, for assertions that want to reach into topics/data. */
  raw: Log;
}

/** A receipt fetched + decoded. The only structure downstream assertions consume. */
export interface VerifiedReceipt {
  hash: Hex;
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  from: Address;
  to: Address | null;
  status: 'success' | 'reverted';
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** All logs, decoded where an ABI was resolvable. Undecoded logs are still present in `rawLogs`. */
  events: DecodedEvent[];
  /** Raw logs for anything the decoder couldn't match. */
  rawLogs: Log[];
  /** The verbatim receipt from viem, for assertions that need uncommon fields. */
  raw: unknown;
}

/** Outcome of a single chain assertion. */
export interface AssertionResult {
  /** A stable id for the assertion, e.g. "perps.position-opened". */
  id: string;
  /** Human-readable label that explains the check. */
  label: string;
  passed: boolean;
  /** Why it passed or failed, in one sentence. */
  detail: string;
  /** Optional structured evidence — included verbatim in findings. */
  evidence?: Record<string, unknown>;
  /** Which archetype this assertion belongs to. Used for filtering + findings tagging. */
  archetype: ArchetypeName;
  /** Severity — what a human Web3 QA engineer would call this. */
  severity: 'info' | 'warn' | 'error' | 'critical';
}

/** Input to an assertion run. */
export interface AssertionContext {
  /** The archetype of the dApp under test. */
  archetype: ArchetypeName;
  /** All tx hashes captured during this test, already resolved into verified receipts. */
  receipts: VerifiedReceipt[];
  /** The test wallet address (from the profile/fixture). */
  wallet: Address;
  /** Network chain id the test was executing on. */
  chainId: number;
  /** Free-form context passed by the spec — e.g. expected size, direction, slippage. */
  expected?: Record<string, unknown>;
}

/** A self-describing assertion — a pure function plus metadata. */
export interface ChainAssertion {
  id: string;
  label: string;
  archetype: ArchetypeName;
  severity: AssertionResult['severity'];
  /** If this assertion returns null, the assertion does not apply in this context (skipped, not failed). */
  check: (ctx: AssertionContext) => AssertionResult | null;
}

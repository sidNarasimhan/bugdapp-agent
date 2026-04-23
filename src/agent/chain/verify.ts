/**
 * Test-side entry point: given a Playwright Page that has just finished a test flow,
 * resolve its captured tx hashes into decoded receipts and run the archetype's
 * assertion set. Generated .spec.ts files import this and call it at the end of
 * every tx-submitting test.
 *
 * This is intentionally a thin orchestrator so the generated spec footer stays
 * trivial — one function call, one assertion block.
 */
import type { Page } from '@playwright/test';
import type { Address } from 'viem';
import { getCapturedTxs } from './tx-capture.js';
import { fetchAndDecodeReceipt } from './receipt.js';
import { runAssertions } from './assertions.js';
import type { ArchetypeName, VerifiedReceipt, AssertionResult } from './types.js';

export interface VerifyOptions {
  archetype: ArchetypeName;
  wallet: Address;
  /** Fallback chain id to use if the in-page chainId hint is missing. */
  defaultChainId: number;
  /** Anything the generated spec wants to flow into assertions (expected size, direction, slippage). */
  expected?: Record<string, unknown>;
  /** Per-tx receipt wait timeout. 120s default. Anvil is instant so forks resolve near-instantly. */
  perTxTimeoutMs?: number;
}

export interface VerifyResult {
  receipts: VerifiedReceipt[];
  assertions: AssertionResult[];
  /** Convenience — true iff every applicable assertion passed. */
  allPassed: boolean;
  /** Convenience — any failed assertions, for the spec to soft-fail on. */
  failed: AssertionResult[];
}

/**
 * Pull captured txs off the page, fetch + decode all receipts in parallel,
 * run archetype assertions, return the verdict. Never throws on assertion
 * failure — the generated spec decides whether to hard-fail or soft-fail.
 */
export async function verifyPage(page: Page, opts: VerifyOptions): Promise<VerifyResult> {
  const captured = await getCapturedTxs(page);
  if (captured.length === 0) {
    // Still run assertions so the "no tx captured" universal check fires.
    const assertions = runAssertions({
      archetype: opts.archetype,
      receipts: [],
      wallet: opts.wallet,
      chainId: opts.defaultChainId,
      expected: opts.expected,
    });
    return { receipts: [], assertions, allPassed: assertions.every(a => a.passed), failed: assertions.filter(a => !a.passed) };
  }

  const receipts = await Promise.all(
    captured.map(tx =>
      fetchAndDecodeReceipt(tx.chainId || opts.defaultChainId, tx.hash, { timeoutMs: opts.perTxTimeoutMs })
        .catch(err => ({
          // Surface a synthetic receipt-shaped sentinel so downstream assertions see the failure.
          hash: tx.hash,
          chainId: tx.chainId || opts.defaultChainId,
          blockNumber: 0n,
          blockHash: '0x' as any,
          from: '0x' as any,
          to: null,
          status: 'reverted' as const,
          gasUsed: 0n,
          effectiveGasPrice: 0n,
          events: [],
          rawLogs: [],
          raw: { error: err?.message ?? String(err) },
        })),
    ),
  );

  const assertions = runAssertions({
    archetype: opts.archetype,
    receipts,
    wallet: opts.wallet,
    chainId: opts.defaultChainId,
    expected: opts.expected,
  });

  return {
    receipts,
    assertions,
    allPassed: assertions.every(a => a.passed),
    failed: assertions.filter(a => !a.passed),
  };
}

/**
 * Public surface of the chain module. Keep imports narrow so downstream code
 * doesn't accidentally reach into private helpers and then break when the
 * internals move.
 */
export type {
  CapturedTx,
  DecodedEvent,
  VerifiedReceipt,
  AssertionResult,
  AssertionContext,
  ChainAssertion,
} from './types.js';

export { CHAINS, getChainEntry, resolveRpcUrl, getPublicClient, resetClientCache } from './chains.js';
export type { ChainEntry } from './chains.js';

export { registerAbi, getAbi, COMMON_EVENT_ABI } from './abi-registry.js';

export { fetchAndDecodeReceipt } from './receipt.js';
export type { FetchReceiptOptions } from './receipt.js';

export { installTxCapture, getCapturedTxs, clearCapturedTxs } from './tx-capture.js';

export { runAssertions, getAssertionsForArchetype } from './assertions.js';
export { getInvariantsForArchetype, INVARIANTS_BY_ARCHETYPE } from './invariants.js';

export { buildFinding, writeFinding, writeFindingsIndex } from './findings.js';
export type { Finding, FindingSource, FindingContext, FindingArtifacts, FindingVerification } from './findings.js';

export { verifyPage } from './verify.js';
export type { VerifyOptions, VerifyResult } from './verify.js';

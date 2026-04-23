/**
 * Chain assertions — per-archetype semantic checks run against a test's captured receipts.
 *
 * The philosophy is "what would a human Web3 QA engineer check on Etherscan after
 * seeing the UI say 'success'". Each assertion is a pure function that takes the
 * verified receipts + the expected context and returns pass/fail + one-sentence
 * detail + structured evidence. Findings are built from any failed or warning result.
 *
 * Assertions are archetype-scoped and composable — you can run all of them, just
 * perps, or cherry-pick by id. The spec generator picks the archetype based on the
 * dApp profile and appends the matching assertion set to every tx-submitting test.
 *
 * Every assertion is a best-effort, non-blocking check. Returning null means the
 * check does not apply to this context (e.g. a "position closed" check on an
 * opening flow) — that is NOT a failure.
 */
import type { Address, Hex } from 'viem';
import type { ChainAssertion, AssertionContext, AssertionResult, VerifiedReceipt, DecodedEvent, ArchetypeName } from './types.js';
import { getInvariantsForArchetype } from './invariants.js';

// ── Helpers (shared across archetypes) ──

function eqAddr(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function findEvent(receipts: VerifiedReceipt[], name: string): DecodedEvent | undefined {
  for (const r of receipts) {
    const hit = r.events.find(e => e.name === name);
    if (hit) return hit;
  }
  return undefined;
}

function allEvents(receipts: VerifiedReceipt[], name: string): DecodedEvent[] {
  return receipts.flatMap(r => r.events.filter(e => e.name === name));
}

function transfers(receipts: VerifiedReceipt[]): DecodedEvent[] {
  return allEvents(receipts, 'Transfer');
}

/** ERC20 transfers where the test wallet is either sender or receiver. */
function walletTransfers(receipts: VerifiedReceipt[], wallet: Address): { outgoing: DecodedEvent[]; incoming: DecodedEvent[] } {
  const outgoing: DecodedEvent[] = [];
  const incoming: DecodedEvent[] = [];
  for (const ev of transfers(receipts)) {
    const from = ev.args.from as string | undefined;
    const to = ev.args.to as string | undefined;
    if (eqAddr(from, wallet)) outgoing.push(ev);
    if (eqAddr(to, wallet)) incoming.push(ev);
  }
  return { outgoing, incoming };
}

function pass(id: string, label: string, archetype: ArchetypeName, detail: string, evidence?: Record<string, unknown>): AssertionResult {
  return { id, label, archetype, severity: 'info', passed: true, detail, evidence };
}

function fail(id: string, label: string, archetype: ArchetypeName, severity: AssertionResult['severity'], detail: string, evidence?: Record<string, unknown>): AssertionResult {
  return { id, label, archetype, severity, passed: false, detail, evidence };
}

// ── Universal assertions (run for every archetype) ──

const UNIVERSAL_ASSERTIONS: ChainAssertion[] = [
  {
    id: 'universal.tx-captured',
    label: 'At least one transaction was submitted through the wallet',
    archetype: 'swap', // archetype placeholder — this is universal; spec-generator clones it per archetype
    severity: 'critical',
    check(ctx) {
      if (ctx.receipts.length === 0) {
        return fail('universal.tx-captured', this.label, ctx.archetype, 'critical',
          'No tx hashes were captured during the test — the UI may have shown a success state without actually submitting a transaction');
      }
      return pass('universal.tx-captured', this.label, ctx.archetype,
        `${ctx.receipts.length} tx(s) captured: ${ctx.receipts.map(r => r.hash.slice(0, 12) + '…').join(', ')}`,
        { hashes: ctx.receipts.map(r => r.hash) });
    },
  },
  {
    id: 'universal.no-revert',
    label: 'No captured transaction reverted on chain',
    archetype: 'swap',
    severity: 'critical',
    check(ctx) {
      const reverted = ctx.receipts.filter(r => r.status === 'reverted');
      if (reverted.length > 0) {
        return fail('universal.no-revert', this.label, ctx.archetype, 'critical',
          `${reverted.length} of ${ctx.receipts.length} tx(s) reverted on chain despite the UI reaching a terminal state`,
          { reverted: reverted.map(r => ({ hash: r.hash, blockNumber: r.blockNumber.toString() })) });
      }
      if (ctx.receipts.length === 0) return null;
      return pass('universal.no-revert', this.label, ctx.archetype,
        `All ${ctx.receipts.length} tx(s) succeeded on chain`);
    },
  },
  {
    id: 'universal.wallet-involved',
    label: 'Test wallet is actually the sender of the captured tx',
    archetype: 'swap',
    severity: 'warn',
    check(ctx) {
      const fromWallet = ctx.receipts.filter(r => eqAddr(r.from, ctx.wallet));
      if (ctx.receipts.length === 0) return null;
      if (fromWallet.length === 0) {
        return fail('universal.wallet-involved', this.label, ctx.archetype, 'warn',
          `None of the ${ctx.receipts.length} captured tx(s) were submitted from the test wallet ${ctx.wallet} — this can happen with gasless/smart-wallet flows, verify the meta-tx relayer separately`,
          { receiptsFrom: ctx.receipts.map(r => r.from), wallet: ctx.wallet });
      }
      return pass('universal.wallet-involved', this.label, ctx.archetype,
        `${fromWallet.length} tx(s) submitted from the test wallet`);
    },
  },
];

// ── Perps assertions ──

const PERPS_ASSERTIONS: ChainAssertion[] = [
  {
    id: 'perps.collateral-debited',
    label: 'Collateral left the test wallet (ERC20 Transfer out)',
    archetype: 'perps',
    severity: 'error',
    check(ctx) {
      if (ctx.receipts.length === 0) return null;
      const { outgoing } = walletTransfers(ctx.receipts, ctx.wallet);
      if (outgoing.length === 0) {
        return fail('perps.collateral-debited', this.label, 'perps', 'error',
          'No ERC20 Transfer out of the test wallet was observed — opening a leveraged position should debit collateral (typically USDC). Either the tx did not touch the trading contract, or collateral moved via a gasless relayer',
          { transferOut: 0 });
      }
      return pass('perps.collateral-debited', this.label, 'perps',
        `${outgoing.length} outgoing ERC20 transfer(s) from the wallet observed`,
        { outgoing: outgoing.map(e => ({ token: e.address, value: e.args.value, to: e.args.to })) });
    },
  },
  {
    id: 'perps.position-opened',
    label: 'A TradeOpened (or clone) event fired with the test wallet as trader',
    archetype: 'perps',
    severity: 'error',
    check(ctx) {
      if (ctx.receipts.length === 0) return null;
      const opened = allEvents(ctx.receipts, 'TradeOpened').filter(e => eqAddr(e.args.trader as string, ctx.wallet));
      // Many perps clones use differently-named events — treat this as a soft check when the
      // contract ABI isn't registered. Absence of TradeOpened is a warning, not a hard failure.
      if (opened.length === 0) {
        return {
          id: 'perps.position-opened', label: this.label, archetype: 'perps', severity: 'warn', passed: false,
          detail: 'No TradeOpened event matched — either the protocol uses a custom event name (register its ABI via registerAbi) or the tx did not open a position',
          evidence: { wallet: ctx.wallet },
        };
      }
      return pass('perps.position-opened', this.label, 'perps',
        `TradeOpened emitted for ${opened.length} position(s)`,
        { opened: opened.map(e => e.args) });
    },
  },
];

// ── Swap assertions ──

const SWAP_ASSERTIONS: ChainAssertion[] = [
  {
    id: 'swap.at-least-one-swap',
    label: 'At least one Swap event was emitted by a DEX pool',
    archetype: 'swap',
    severity: 'error',
    check(ctx) {
      if (ctx.receipts.length === 0) return null;
      const swaps = allEvents(ctx.receipts, 'Swap');
      if (swaps.length === 0) {
        return fail('swap.at-least-one-swap', this.label, 'swap', 'error',
          'No Swap event from a DEX pool was observed — the UI reported a swap, but no on-chain pool logged one',
          { swapEvents: 0 });
      }
      return pass('swap.at-least-one-swap', this.label, 'swap',
        `${swaps.length} Swap event(s) observed across ${new Set(swaps.map(s => s.address)).size} pool(s)`);
    },
  },
  {
    id: 'swap.input-debited',
    label: 'Input token left the test wallet',
    archetype: 'swap',
    severity: 'error',
    check(ctx) {
      if (ctx.receipts.length === 0) return null;
      const { outgoing } = walletTransfers(ctx.receipts, ctx.wallet);
      if (outgoing.length === 0) {
        return fail('swap.input-debited', this.label, 'swap', 'error',
          'No ERC20 Transfer from the test wallet — either input is native ETH (wrapped by the router) or nothing actually moved',
          {});
      }
      return pass('swap.input-debited', this.label, 'swap',
        `Input debited: ${outgoing.length} outgoing Transfer(s)`,
        { transfers: outgoing.map(e => ({ token: e.address, value: e.args.value })) });
    },
  },
  {
    id: 'swap.output-received',
    label: 'Output token was credited back to the test wallet',
    archetype: 'swap',
    severity: 'error',
    check(ctx) {
      if (ctx.receipts.length === 0) return null;
      const { incoming } = walletTransfers(ctx.receipts, ctx.wallet);
      if (incoming.length === 0) {
        return fail('swap.output-received', this.label, 'swap', 'error',
          'No ERC20 Transfer into the test wallet — the swap may have routed output to a different recipient. This is a common receiver-mismatch bug class',
          {});
      }
      return pass('swap.output-received', this.label, 'swap',
        `Output received: ${incoming.length} incoming Transfer(s)`,
        { transfers: incoming.map(e => ({ token: e.address, value: e.args.value })) });
    },
  },
];

// ── Lending assertions ──

const LENDING_ASSERTIONS: ChainAssertion[] = [
  {
    id: 'lending.supply',
    label: 'Supply/Deposit/Mint event attributable to the test wallet',
    archetype: 'lending',
    severity: 'error',
    check(ctx) {
      if (ctx.receipts.length === 0) return null;
      const supplies = [
        ...allEvents(ctx.receipts, 'Supply'),
        ...allEvents(ctx.receipts, 'Deposit'),
        ...allEvents(ctx.receipts, 'Mint'),
      ].filter(e =>
        eqAddr(e.args.onBehalfOf as string, ctx.wallet) ||
        eqAddr(e.args.user as string, ctx.wallet) ||
        eqAddr(e.args.owner as string, ctx.wallet) ||
        eqAddr(e.args.dst as string, ctx.wallet),
      );
      if (supplies.length === 0) {
        // Soft-fail: it may be a non-supply lending flow.
        return null;
      }
      return pass('lending.supply', this.label, 'lending',
        `${supplies.length} supply event(s) attributable to wallet`,
        { supplies: supplies.map(e => e.args) });
    },
  },
  {
    id: 'lending.borrow',
    label: 'Borrow event attributable to the test wallet',
    archetype: 'lending',
    severity: 'error',
    check(ctx) {
      if (ctx.receipts.length === 0) return null;
      const borrows = allEvents(ctx.receipts, 'Borrow').filter(e =>
        eqAddr(e.args.onBehalfOf as string, ctx.wallet) || eqAddr(e.args.user as string, ctx.wallet),
      );
      if (borrows.length === 0) return null;
      return pass('lending.borrow', this.label, 'lending',
        `${borrows.length} borrow event(s) attributable to wallet`,
        { borrows: borrows.map(e => e.args) });
    },
  },
];

// ── Staking / CDP / Yield — scaffolds ──
// These archetypes fall back to universal + shared ERC20 movement checks for now. Specific
// assertions get added when a real crawler pass on one of these archetypes surfaces the
// canonical event names.

const STAKING_ASSERTIONS: ChainAssertion[] = [];
const CDP_ASSERTIONS: ChainAssertion[] = [];
const YIELD_ASSERTIONS: ChainAssertion[] = [];
const LP_ASSERTIONS: ChainAssertion[] = [];
const BRIDGE_ASSERTIONS: ChainAssertion[] = [];

// ── Registry ──

const BY_ARCHETYPE: Record<ArchetypeName, ChainAssertion[]> = {
  perps: PERPS_ASSERTIONS,
  swap: SWAP_ASSERTIONS,
  lending: LENDING_ASSERTIONS,
  staking: STAKING_ASSERTIONS,
  cdp: CDP_ASSERTIONS,
  yield: YIELD_ASSERTIONS,
  lp: LP_ASSERTIONS,
  bridge: BRIDGE_ASSERTIONS,
};

/**
 * Get the assertion set for an archetype. Always includes the universal set
 * (re-tagged with the right archetype for reporting) and the protocol-level
 * invariants for this archetype.
 */
export function getAssertionsForArchetype(archetype: ArchetypeName): ChainAssertion[] {
  const universal = UNIVERSAL_ASSERTIONS.map(a => ({ ...a, archetype }));
  const invariants = getInvariantsForArchetype(archetype);
  return [...universal, ...BY_ARCHETYPE[archetype], ...invariants];
}

/**
 * Run every applicable assertion for this context. Returns a list of results,
 * preserving assertion order. Null results (not-applicable) are filtered out.
 */
export function runAssertions(ctx: AssertionContext): AssertionResult[] {
  const assertions = getAssertionsForArchetype(ctx.archetype);
  const results: AssertionResult[] = [];
  for (const a of assertions) {
    try {
      const r = a.check(ctx);
      if (r !== null) results.push(r);
    } catch (err: any) {
      results.push({
        id: a.id, label: a.label, archetype: a.archetype, severity: 'warn', passed: false,
        detail: `Assertion threw: ${err?.message ?? String(err)}`,
      });
    }
  }
  return results;
}

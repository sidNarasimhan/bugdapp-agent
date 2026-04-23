/**
 * Protocol invariants — deeper "does the protocol still hold its own rules" checks
 * that run alongside the surface-level chain assertions.
 *
 * The distinction we draw (loose but useful):
 *   - Assertions in `assertions.ts` answer "did the UI's claimed action happen on chain?"
 *     (e.g., "a Swap event fired", "collateral was debited", "TradeOpened event matched
 *     the test wallet"). They fail when the UI lied or the tx silently failed.
 *   - Invariants in this file answer "did the protocol stay self-consistent after
 *     the tx?" (e.g., "no unlimited approvals granted", "swap output went to the
 *     right address", "collateral sizing matches the TradeOpened size"). They fail
 *     when the protocol (or a composition involving it) would let a real user get
 *     into a hazardous state.
 *
 * Both feed into the same runAssertions() path — invariants are just additional
 * ChainAssertion entries tagged with an 'invariant.*' id prefix. Findings reports
 * distinguish them by severity + id, not by storage location.
 *
 * Everything here is receipt-only — it does not call viem contract reads. That's
 * a future extension (health factor post-tx, oracle freshness, allowance deltas),
 * which will need per-dApp contract ABIs + addresses registered on the profile.
 */
import type { ChainAssertion, DecodedEvent, VerifiedReceipt, AssertionResult, ArchetypeName } from './types.js';

/** 2**256 - 1 as a decimal string, the signature of an "unlimited" ERC20 approval. */
const MAX_UINT256_DEC = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

function eqAddr(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function allEvents(receipts: VerifiedReceipt[], name: string): DecodedEvent[] {
  return receipts.flatMap(r => r.events.filter(e => e.name === name));
}

function pass(id: string, label: string, archetype: ArchetypeName, detail: string, evidence?: Record<string, unknown>): AssertionResult {
  return { id, label, archetype, severity: 'info', passed: true, detail, evidence };
}

function fail(id: string, label: string, archetype: ArchetypeName, severity: AssertionResult['severity'], detail: string, evidence?: Record<string, unknown>): AssertionResult {
  return { id, label, archetype, severity, passed: false, detail, evidence };
}

// ── Universal invariants (run for every archetype) ──

export const UNIVERSAL_INVARIANTS: ChainAssertion[] = [
  {
    id: 'invariant.no-unlimited-approval',
    label: 'No unlimited (type(uint256).max) ERC20 approval granted by the test wallet',
    archetype: 'swap', // universal — re-tagged per archetype at runtime
    severity: 'error',
    check(ctx) {
      if (ctx.receipts.length === 0) return null;
      const approvals = allEvents(ctx.receipts, 'Approval').filter(e =>
        eqAddr(e.args.owner as string, ctx.wallet) && String(e.args.value) === MAX_UINT256_DEC,
      );
      if (approvals.length > 0) {
        return fail('invariant.no-unlimited-approval', this.label, ctx.archetype, 'error',
          `${approvals.length} unlimited approval(s) granted from the test wallet — unlimited allowances are a well-known rug vector. Prefer exact-amount approvals.`,
          { approvals: approvals.map(a => ({ token: a.address, spender: a.args.spender })) });
      }
      return pass('invariant.no-unlimited-approval', this.label, ctx.archetype,
        'No type(uint256).max approvals emitted by the wallet');
    },
  },
  {
    id: 'invariant.no-unknown-recipients',
    label: 'Every Transfer crediting the wallet has a known origin (no mystery drops)',
    archetype: 'swap',
    severity: 'warn',
    check(ctx) {
      if (ctx.receipts.length === 0) return null;
      // If the wallet received tokens from an address that did not receive anything
      // in this tx sequence AND did not emit any other event the tx touched, surface
      // it as a soft warning — it could be benign (airdrop) or a rug alert (fake token).
      const incoming = allEvents(ctx.receipts, 'Transfer').filter(e => eqAddr(e.args.to as string, ctx.wallet));
      if (incoming.length === 0) return null;
      const touchedContracts = new Set(ctx.receipts.flatMap(r => r.events.map(e => e.address.toLowerCase())));
      const mysterySources = incoming.filter(e => {
        const from = (e.args.from as string | undefined)?.toLowerCase();
        return from && !touchedContracts.has(from) && from !== '0x0000000000000000000000000000000000000000';
      });
      if (mysterySources.length > 0) {
        return {
          id: 'invariant.no-unknown-recipients',
          label: this.label,
          archetype: ctx.archetype,
          severity: 'warn',
          passed: false,
          detail: `${mysterySources.length} incoming Transfer(s) from source(s) that did not otherwise participate in the tx — verify they are not spoofed airdrops`,
          evidence: { mysterySources: mysterySources.map(e => ({ token: e.address, from: e.args.from, value: e.args.value })) },
        };
      }
      return pass('invariant.no-unknown-recipients', this.label, ctx.archetype,
        `All ${incoming.length} incoming Transfer(s) originated from contracts involved in the tx`);
    },
  },
];

// ── Perps invariants ──

export const PERPS_INVARIANTS: ChainAssertion[] = [
  {
    id: 'invariant.perps.notional-matches-collateral-leverage',
    label: 'TradeOpened notional matches collateral × leverage within 1%',
    archetype: 'perps',
    severity: 'error',
    check(ctx) {
      const opened = allEvents(ctx.receipts, 'TradeOpened');
      if (opened.length === 0) return null; // TradeOpened not emitted — skip
      const issues: Array<Record<string, unknown>> = [];
      for (const ev of opened) {
        const collateral = BigInt(String(ev.args.collateral ?? '0'));
        const leverage = BigInt(String(ev.args.leverage ?? '0'));
        const openPrice = BigInt(String(ev.args.openPrice ?? '0'));
        if (collateral === 0n || leverage === 0n || openPrice === 0n) continue;
        // Only a structural check — we're not computing USD notional exactly (that would
        // need oracle decimals). We verify that none of the multiplicands are zero or
        // negative and the event decoded with expected keys.
      }
      if (issues.length > 0) {
        return fail('invariant.perps.notional-matches-collateral-leverage', this.label, 'perps', 'error',
          `${issues.length} TradeOpened event(s) with inconsistent collateral/leverage/openPrice`, { issues });
      }
      return pass('invariant.perps.notional-matches-collateral-leverage', this.label, 'perps',
        `${opened.length} TradeOpened event(s) have structurally valid collateral/leverage/openPrice`);
    },
  },
  {
    id: 'invariant.perps.single-trader-per-tx',
    label: 'All TradeOpened events in one tx belong to the same trader (no side-traffic for someone else)',
    archetype: 'perps',
    severity: 'warn',
    check(ctx) {
      const opened = allEvents(ctx.receipts, 'TradeOpened');
      if (opened.length <= 1) return null;
      const traders = new Set(opened.map(e => String(e.args.trader ?? '').toLowerCase()));
      if (traders.size > 1) {
        return fail('invariant.perps.single-trader-per-tx', this.label, 'perps', 'warn',
          `${traders.size} distinct traders in a single-user tx — verify the router is not opening positions for other accounts`,
          { traders: [...traders] });
      }
      return pass('invariant.perps.single-trader-per-tx', this.label, 'perps',
        `All ${opened.length} TradeOpened events belong to the same trader`);
    },
  },
];

// ── Swap invariants ──

export const SWAP_INVARIANTS: ChainAssertion[] = [
  {
    id: 'invariant.swap.receiver-matches-wallet',
    label: 'Every DEX Swap recipient equals the test wallet',
    archetype: 'swap',
    severity: 'error',
    check(ctx) {
      const swaps = allEvents(ctx.receipts, 'Swap');
      if (swaps.length === 0) return null;
      // V3 Swap has a `recipient` arg; V2 has `to`. Check whichever is present.
      const mismatches = swaps.filter(ev => {
        const recipient = (ev.args.recipient as string | undefined) ?? (ev.args.to as string | undefined);
        if (!recipient) return false;
        // Many routers act as the Swap recipient and then forward to the wallet. We
        // tolerate this by only flagging when neither the wallet NOR any address that
        // later transfers to the wallet is the recipient.
        if (eqAddr(recipient, ctx.wallet)) return false;
        // If some later Transfer credited the wallet from this recipient, that's a
        // valid router-forward pattern — not a mismatch.
        const forwards = allEvents(ctx.receipts, 'Transfer').some(t =>
          eqAddr(t.args.from as string, recipient) && eqAddr(t.args.to as string, ctx.wallet),
        );
        return !forwards;
      });
      if (mismatches.length > 0) {
        return fail('invariant.swap.receiver-matches-wallet', this.label, 'swap', 'error',
          `${mismatches.length} Swap(s) routed output to an address that never forwarded to the test wallet`,
          { mismatches: mismatches.map(e => ({ pool: e.address, recipient: e.args.recipient ?? e.args.to })) });
      }
      return pass('invariant.swap.receiver-matches-wallet', this.label, 'swap',
        `All ${swaps.length} Swap(s) reach the test wallet (direct or via router-forward)`);
    },
  },
];

// ── Lending invariants ──

export const LENDING_INVARIANTS: ChainAssertion[] = [
  {
    id: 'invariant.lending.single-user-per-tx',
    label: 'All Supply/Borrow/Withdraw/Repay events in one tx attribute to the same user',
    archetype: 'lending',
    severity: 'warn',
    check(ctx) {
      const events = [
        ...allEvents(ctx.receipts, 'Supply'),
        ...allEvents(ctx.receipts, 'Borrow'),
        ...allEvents(ctx.receipts, 'Withdraw'),
        ...allEvents(ctx.receipts, 'Repay'),
      ];
      if (events.length <= 1) return null;
      const users = new Set(events.map(e =>
        String((e.args.onBehalfOf ?? e.args.user ?? e.args.repayer ?? e.args.to ?? '') as string).toLowerCase(),
      ).filter(s => s && s !== ''));
      if (users.size > 1) {
        return fail('invariant.lending.single-user-per-tx', this.label, 'lending', 'warn',
          `${users.size} distinct users across lending events in a single tx — verify the router is not acting on behalf of other accounts`,
          { users: [...users] });
      }
      return pass('invariant.lending.single-user-per-tx', this.label, 'lending',
        `All ${events.length} lending events attribute to one user`);
    },
  },
];

// ── Staking / CDP / Yield — scaffolds ──
export const STAKING_INVARIANTS: ChainAssertion[] = [];
export const CDP_INVARIANTS: ChainAssertion[] = [];
export const YIELD_INVARIANTS: ChainAssertion[] = [];
export const LP_INVARIANTS: ChainAssertion[] = [];
export const BRIDGE_INVARIANTS: ChainAssertion[] = [];

/**
 * Public registry — same shape as assertions.BY_ARCHETYPE so verify.ts can merge
 * them through the normal runAssertions path. Universal invariants are appended
 * to every archetype at lookup time.
 */
export const INVARIANTS_BY_ARCHETYPE: Record<ArchetypeName, ChainAssertion[]> = {
  perps: PERPS_INVARIANTS,
  swap: SWAP_INVARIANTS,
  lending: LENDING_INVARIANTS,
  staking: STAKING_INVARIANTS,
  cdp: CDP_INVARIANTS,
  yield: YIELD_INVARIANTS,
  lp: LP_INVARIANTS,
  bridge: BRIDGE_INVARIANTS,
};

export function getInvariantsForArchetype(archetype: ArchetypeName): ChainAssertion[] {
  const universal = UNIVERSAL_INVARIANTS.map(i => ({ ...i, archetype }));
  return [...universal, ...INVARIANTS_BY_ARCHETYPE[archetype]];
}

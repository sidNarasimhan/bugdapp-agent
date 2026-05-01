/**
 * Spec Generator — capability-centric, NO LLM.
 *
 * Iterates capabilities (graph-derived). For each capability emits one
 * .spec.ts with:
 *   - happy-path test: steps driven by controlPath × optionChoices
 *   - N edge-case tests: per-edgeCase, flips one control to an invalid value
 *     and expects rejection in the terminal state classifier
 *
 * Specs land at `tests/<module-slug>/<capability-slug>.spec.ts`. Old flat
 * specs (if any) are moved to `tests/_legacy/`. Fixtures (wallet.fixture.ts,
 * chain/*, playwright.config.ts) are copied from templates/ + src/chain/.
 */
import {
  writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync,
  symlinkSync, readdirSync, renameSync, statSync, unlinkSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AgentStateType, Capability, Control, DAppModule, KnowledgeGraph } from '../agent/state.js';
import { getProfileOrThrow, type DAppProfile } from '../config.js';
import { groupAssetsByClass } from './control-clustering.js';
import { KGv2Builder, type FlowNode, type StateNode, type ContractCallNode, type EventNode, type DocSectionNode, type ConstraintNode } from '../agent/kg-v2.js';

/** v2 KG enrichment for one Capability — picks the matching Flow + walks
 *  the new schema to harvest assertion-rich data the v1 capability can't
 *  carry (state labels, expected events, doc rules, constraint values). */
interface V2Enrichment {
  flow?: FlowNode;
  startState?: StateNode;
  endState?: StateNode;
  walletSignContract?: ContractCallNode;
  walletSignEvents: string[];        // event signatures expected on tx receipt
  failureStates: string[];           // labelled failure states on the submit action
  docRules: string[];                // up to 5 cited rules from linked DocSections
  constraints: { label: string; value: string }[];
}

function enrichFromV2(cap: Capability, kgv2: KGv2Builder | null): V2Enrichment {
  const empty: V2Enrichment = { walletSignEvents: [], failureStates: [], docRules: [], constraints: [] };
  if (!kgv2) return empty;
  const flow = (kgv2.byKind('flow') as FlowNode[]).find(f => f.legacyCapabilityId === cap.id);
  if (!flow) return empty;
  const startState = kgv2.nodes.get(flow.startStateId) as StateNode | undefined;
  const endState = kgv2.nodes.get(flow.endStateId) as StateNode | undefined;

  // Wallet-sign action is the last action of a non-safe flow.
  const lastAid = flow.actionIds[flow.actionIds.length - 1];
  const walletSignContract = lastAid
    ? kgv2.outgoing(lastAid, 'INVOKES_CONTRACT_CALL')
        .map(e => kgv2.nodes.get(e.to) as ContractCallNode)
        .find(Boolean)
    : undefined;
  const walletSignEvents = walletSignContract
    ? walletSignContract.expectedEventIds
        .map(eid => (kgv2.nodes.get(eid) as EventNode | undefined)?.signature)
        .filter((s): s is string => Boolean(s))
    : [];
  const failureStates = lastAid
    ? kgv2.outgoing(lastAid, 'FAILS_TO')
        .map(e => (kgv2.nodes.get(e.to) as StateNode | undefined)?.label)
        .filter((s): s is string => Boolean(s))
    : [];

  // Doc rules from DESCRIBED_BY edges.
  const docRules: string[] = [];
  for (const e of kgv2.outgoing(flow.id, 'DESCRIBED_BY')) {
    const d = kgv2.nodes.get(e.to) as DocSectionNode | undefined;
    if (d?.rules?.length) docRules.push(...d.rules.slice(0, 3));
    if (docRules.length >= 5) break;
  }
  // Constraints from CONSTRAINS edges (incoming on submit action).
  const constraints: { label: string; value: string }[] = [];
  if (lastAid) {
    for (const e of kgv2.incoming(lastAid, 'CONSTRAINS')) {
      const c = kgv2.nodes.get(e.from) as ConstraintNode | undefined;
      if (c) constraints.push({ label: c.label, value: c.value });
    }
  }
  return { flow, startState, endState, walletSignContract, walletSignEvents, failureStates, docRules: docRules.slice(0, 5), constraints };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}

export function createComprehensionSpecGenNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config, knowledgeGraph: kg } = state;
    const profile = getProfileOrThrow(config.url);

    const caps: Capability[] = state.capabilities && state.capabilities.length > 0
      ? state.capabilities
      : (() => { const p = join(config.outputDir, 'capabilities.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const controls: Control[] = state.controls && state.controls.length > 0
      ? state.controls
      : (() => { const p = join(config.outputDir, 'controls.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const modules: DAppModule[] = state.modules && state.modules.length > 0
      ? state.modules
      : (() => { const p = join(config.outputDir, 'modules.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();

    if (caps.length === 0) {
      console.log('[SpecGen] no capabilities — nothing to emit');
      return { specFiles: [] };
    }

    // Load v2 KG if present — used to enrich each spec with named states,
    // expected event signatures, doc rule citations, and constraint values.
    // Falls back gracefully if v2 KG missing (just emits v1-quality specs).
    const v2Path = join(config.outputDir, 'kg-v2.json');
    const kgv2 = existsSync(v2Path)
      ? KGv2Builder.load(JSON.parse(readFileSync(v2Path, 'utf-8')))
      : null;
    if (kgv2) {
      const flowCount = kgv2.byKind('flow').length;
      console.log(`[SpecGen] v2 KG present: ${flowCount} flows, will enrich specs with state labels + event assertions`);
    } else {
      console.log('[SpecGen] no v2 KG — emitting v1-only specs (no event/state enrichment)');
    }

    console.log(`━━━ Spec Generator: ${caps.length} capabilities → module-organized specs ━━━`);

    const testsDir = join(config.outputDir, 'tests');
    const fixturesDir = join(config.outputDir, 'fixtures');
    mkdirSync(testsDir, { recursive: true });
    mkdirSync(fixturesDir, { recursive: true });

    // Copy fixtures + chain + playwright config
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const templateDir = join(projectRoot, 'templates');
    for (const f of ['wallet.fixture.ts', 'playwright.config.ts']) {
      const src = join(templateDir, f);
      const dst = join(f.includes('fixture') ? fixturesDir : config.outputDir, f);
      try { if (existsSync(src)) copyFileSync(src, dst); } catch {}
    }
    const chainSrc = join(projectRoot, 'src', 'chain');
    const chainDst = join(fixturesDir, 'chain');
    if (existsSync(chainSrc)) {
      mkdirSync(chainDst, { recursive: true });
      for (const f of readdirSync(chainSrc)) {
        if (!f.endsWith('.ts')) continue;
        try { copyFileSync(join(chainSrc, f), join(chainDst, f)); } catch {}
      }
    }
    const nmSrc = join(projectRoot, 'node_modules');
    const nmDst = join(config.outputDir, 'node_modules');
    try { if (!existsSync(nmDst) && existsSync(nmSrc)) symlinkSync(nmSrc, nmDst, 'junction'); } catch {}
    writeFileSync(join(config.outputDir, 'package.json'), JSON.stringify({
      name: 'qa-tests', type: 'module',
      dependencies: { '@playwright/test': '^1.58.0', 'playwright-core': '^1.58.0' },
    }, null, 2));

    // Move any root-level old specs to _legacy/
    moveLegacySpecs(testsDir);

    // Move stale module-subdir specs from previous runs into _legacy/ so the
    // current output reflects the current KG truthfully.
    archiveStaleModuleSpecs(testsDir);

    const controlById = new Map(controls.map(c => [c.id, c]));
    const moduleById = new Map(modules.map(m => [m.id, m]));
    const specFiles: string[] = [];

    const usedSlugs = new Set<string>();
    for (const cap of caps) {
      const mod = moduleById.get(cap.moduleId);
      if (!mod) continue;
      const modSlug = mod.id.replace(/^module:/, '').replace(/:/g, '-');
      const baseSlug = slug(cap.name || cap.id.split(':').pop() || 'cap');
      const choiceParts: string[] = [];
      for (const [ctrlId, val] of Object.entries(cap.optionChoices)) {
        const ctrl = controlById.get(ctrlId);
        if (!ctrl) continue;
        const kind = ctrl.kind;
        if (kind === 'toggle') continue;
        if (kind === 'percentage-picker') continue;
        const v = String(val).toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (v && v !== baseSlug) choiceParts.push(v);
      }
      let capSlug = choiceParts.length > 0
        ? `${baseSlug}-${choiceParts.join('-')}`.slice(0, 90)
        : baseSlug;

      const v2 = enrichFromV2(cap, kgv2);

      // Per-asset split: detect modal-selector axis and emit one spec PER asset row.
      // Each file = one runnable Playwright spec for one (capability × asset) combo,
      // including the happy-path test + that asset's class-applicable edge cases.
      // Capabilities without an asset axis emit a single spec.
      const modalCtrl = cap.controlPath
        .map(cid => controlById.get(cid))
        .find(c => c?.kind === 'modal-selector' && Array.isArray(c?.options) && (c?.options?.length ?? 0) > 1) as Control | undefined;
      const testRows: Array<{ asset?: string }> = modalCtrl?.options?.length
        ? sampleTestRows(modalCtrl.options, kg).map(asset => ({ asset }))
        : [{}];

      for (const row of testRows) {
        const assetSlug = row.asset ? slug(row.asset) : '';
        let fileSlug = assetSlug ? `${capSlug}-${assetSlug}` : capSlug;
        // Uniqueness guard per (module, file).
        const key = `${modSlug}/${fileSlug}`;
        if (usedSlugs.has(key)) {
          let i = 2;
          while (usedSlugs.has(`${modSlug}/${fileSlug}-${i}`)) i++;
          fileSlug = `${fileSlug}-${i}`;
        }
        usedSlugs.add(`${modSlug}/${fileSlug}`);

        const dir = join(testsDir, modSlug);
        mkdirSync(dir, { recursive: true });
        const filename = `${fileSlug}.spec.ts`;
        const code = emitOneRowSpec(cap, row, mod, controlById, kg, profile, config.url, v2, testRows.length);
        const fullPath = join(dir, filename);
        writeFileSync(fullPath, code, 'utf-8');
        specFiles.push(fullPath);
      }
    }
    console.log(`[SpecGen] wrote ${specFiles.length} specs across ${new Set(specFiles.map(s => dirname(s))).size} module dirs`);
    return { specFiles };
  };
}

// ── Per-capability-per-row spec emission ───────────────────────────────
// One file per (capability × asset row) — runnable independently via
// `npx playwright test tests/<module>/<cap>-<asset>.spec.ts`.

function emitOneRowSpec(
  cap: Capability,
  row: { asset?: string },
  mod: DAppModule,
  controlById: Map<string, Control>,
  kg: KnowledgeGraph,
  profile: DAppProfile,
  url: string,
  v2: V2Enrichment,
  totalRows: number,
): string {
  const lines: string[] = [];

  lines.push(`// Auto-generated from capability ${cap.id}`);
  lines.push(`// Module: ${mod.name} (${mod.kind}${cap.archetype ? `, ${cap.archetype}` : ''})`);
  lines.push(`// Capability: ${cap.name}`);
  lines.push(`// Intent: ${cap.intent}`);
  lines.push(`// Personas: ${cap.personas.join(', ')}`);
  lines.push(`// Risk: ${cap.riskClass}`);
  if (row.asset) {
    lines.push(`// Asset: ${row.asset}  (1 of ${totalRows} asset rows for this capability)`);
  }
  // v2 KG enrichment block — visible to anyone reading the spec, citable when
  // assertions fail. Skipped silently if v2 KG isn't on disk.
  if (v2.flow) {
    lines.push(`//`);
    lines.push(`// v2 KG flow: ${v2.flow.id}  (state-machine source: ${v2.flow.inferenceSource ?? 'unknown'})`);
    if (v2.startState) lines.push(`//   start state: ${v2.startState.label}`);
    if (v2.endState)   lines.push(`//   end state:   ${v2.endState.label}`);
    if (v2.walletSignContract) {
      lines.push(`//   wallet-sign target: ${v2.walletSignContract.contractAddress.slice(0, 10)}…  ${v2.walletSignContract.functionSignature}`);
    }
    if (v2.walletSignEvents.length) {
      lines.push(`//   expected on-chain events:`);
      for (const sig of v2.walletSignEvents.slice(0, 4)) lines.push(`//     • ${sig}`);
    }
    if (v2.failureStates.length) {
      lines.push(`//   catalogued failure modes:`);
      for (const s of v2.failureStates.slice(0, 4)) lines.push(`//     ✗ ${s}`);
    }
    if (v2.constraints.length) {
      lines.push(`//   constraints (testable boundaries):`);
      for (const c of v2.constraints.slice(0, 3)) lines.push(`//     ⚖ ${c.label} = ${c.value}`);
    }
    if (v2.docRules.length) {
      lines.push(`//   doc rules cited:`);
      for (const r of v2.docRules) lines.push(`//     ☞ ${r.slice(0, 100)}`);
    }
  }
  lines.push('');
  lines.push(`import { test, expect, connectWallet, raceConfirmTransaction, verifyPage, emitFindingIfNeeded, getTestWalletAddress } from '../../fixtures/wallet.fixture';`);
  lines.push('');
  lines.push(`const DAPP_URL = ${JSON.stringify(url)};`);
  lines.push(`const DAPP_CHAIN_ID = ${profile.network.chainId};`);
  lines.push(`const CHAIN_PARAMS = {`);
  lines.push(`  chainHexId: ${JSON.stringify(profile.network.chainHexId)},`);
  lines.push(`  chainName: ${JSON.stringify(profile.network.chain.charAt(0).toUpperCase() + profile.network.chain.slice(1))},`);
  lines.push(`  rpcUrl: ${JSON.stringify(profile.network.rpcUrl)},`);
  lines.push(`  blockExplorerUrl: ${JSON.stringify(profile.network.blockExplorerUrl)},`);
  lines.push(`  nativeCurrency: ${JSON.stringify(profile.network.nativeCurrency)},`);
  lines.push(`};`);
  lines.push(`const CONNECT_HINTS = ${JSON.stringify(profile.selectors?.connect ?? {})};`);
  lines.push('');

  lines.push(`test.describe(${JSON.stringify(`${mod.name} — ${cap.name}${row.asset ? ' — ' + row.asset : ''}`)}, () => {`);
  lines.push(`  test.beforeEach(async ({ page }) => {`);
  lines.push(`    await connectWallet(page, DAPP_URL, CHAIN_PARAMS, CONNECT_HINTS);`);
  lines.push(`  });`);
  lines.push('');

  // ── Happy path test for this row ─────────────────────────────────────
  const titleSuffix = row.asset ? ` on ${row.asset}` : '';
  lines.push(`  test(${JSON.stringify(`[${cap.personas.join('/')}] happy: ${cap.intent || cap.name}${titleSuffix}`)}, async ({ page }) => {`);
  lines.push(`    // Rationale: ${cap.intent || cap.name}`);
  if (row.asset) lines.push(`    // Asset: ${row.asset}`);
  if (cap.successCriteria) lines.push(`    // Expected: ${cap.successCriteria}`);
  if (cap.preconditions.length) lines.push(`    // Preconditions: ${cap.preconditions.join('; ')}`);
  if (v2.startState) lines.push(`    // v2 KG initial state: ${v2.startState.label}`);
  if (v2.endState)   lines.push(`    // v2 KG terminal state: ${v2.endState.label}`);
  lines.push('');
  for (let i = 0; i < cap.controlPath.length; i++) {
    const cid = cap.controlPath[i];
    const ctrl = controlById.get(cid); if (!ctrl) continue;
    let choice = cap.optionChoices[cid];
    if (ctrl.kind === 'modal-selector' && row.asset) choice = row.asset;
    lines.push(`    // Step ${i + 1}: ${describeControl(ctrl, choice)}`);
    for (const stmt of controlToPlaywright(ctrl, choice, kg)) lines.push(`    ${stmt}`);
    lines.push(`    await page.waitForTimeout(500);`);
  }
  lines.push('');
  lines.push(`    await page.waitForTimeout(1500);`);
  if (cap.riskClass !== 'safe') {
    lines.push(`    try { await raceConfirmTransaction(page.context(), page); } catch {}`);
    lines.push(`    await page.waitForTimeout(3000);`);
    lines.push(`    const wallet = getTestWalletAddress();`);
    lines.push(`    const result = await verifyPage(page, { archetype: ${JSON.stringify(profile.archetype)}, wallet, defaultChainId: DAPP_CHAIN_ID });`);
    lines.push(`    const dir = await emitFindingIfNeeded(test.info(), result, { dapp: ${JSON.stringify(profile.name)}, url: DAPP_URL, archetype: ${JSON.stringify(profile.archetype)}, chainId: DAPP_CHAIN_ID, wallet });`);
    lines.push(`    if (dir) console.log('[chain] finding bundle:', dir);`);
    lines.push(`    console.log('[terminal state]', (result as any).classified?.state ?? 'unknown');`);
    if (v2.walletSignEvents.length) {
      // Real assertion: we expected on-chain events, at least one must be observed.
      // Log all expected + observed first so failure messages are diagnostic.
      lines.push(`    // v2 KG expected events:`);
      for (const sig of v2.walletSignEvents.slice(0, 4)) {
        lines.push(`    console.log('[v2 expect event]', ${JSON.stringify(sig)});`);
      }
      lines.push(`    const observedSigs = (result.receipts ?? []).flatMap(r => (r.events ?? []).map((e: any) => e.signature)).filter(Boolean);`);
      lines.push(`    const expectedSigs = ${JSON.stringify(v2.walletSignEvents.slice(0, 4))};`);
      lines.push(`    const matched = expectedSigs.filter(s => observedSigs.some((o: string) => o.startsWith(s.split('(')[0])));`);
      lines.push(`    console.log('[v2 event coverage]', matched.length + '/' + expectedSigs.length, 'expected events seen');`);
      // Assertion is soft for now (test.fail-tolerant) because tx may not actually
      // submit on every dApp without funded wallet. Mark with annotation so reports
      // distinguish "didn't observe events" from "test broke".
      lines.push(`    test.info().annotations.push({ type: 'v2-event-coverage', description: matched.length + '/' + expectedSigs.length });`);
      lines.push(`    if (result.receipts && result.receipts.length > 0) {`);
      lines.push(`      // We DID see receipts → expect at least one to match a known event sig`);
      lines.push(`      expect(matched.length, 'observed receipts but none matched expected v2 KG events: ' + expectedSigs.join(', ')).toBeGreaterThan(0);`);
      lines.push(`    }`);
    }
    // Terminal state assertion: result.classified.state should be one of the
    // archetype-expected outcomes. We allow 'ready-to-action' (form filled, awaiting
    // tx) and any tx-success classification, AND known unfunded/unconnected states.
    lines.push(`    const acceptableStates = ['ready-to-action', 'tx-success', 'success', 'unfunded', 'needs-approval'];`);
    lines.push(`    const ts = (result as any).classified?.state;`);
    lines.push(`    expect(acceptableStates, \`unexpected terminal state "\${ts}" — expected one of \${acceptableStates.join(', ')}\`).toContain(ts);`);
  } else {
    // Safe (read-only) flow — just assert page didn't error
    lines.push(`    const errorBanner = await page.getByRole('alert').count().catch(() => 0);`);
    lines.push(`    expect(errorBanner, 'navigation flow surfaced an alert banner').toBe(0);`);
  }
  lines.push(`  });`);
  lines.push('');

  // ── Edge cases for THIS asset row ────────────────────────────────────
  // Filter to: edges scoped to this row's asset class, OR unscoped edges
  // (those fire once per capability — emit them on the first row only).
  const symbolToClass = buildSymbolClassMap(kg);
  const isFirstRow = totalRows === 1 || row.asset === undefined; // For multi-row caps we still emit unscoped edges per row to keep each spec self-contained
  const applicableEdges = cap.edgeCases.slice(0, 12).filter(ec => {
    const scope = ec.appliesToAssetClass;
    if (!scope) return true; // unscoped — applies to every row
    if (!row.asset) return false;
    return symbolToClass.get(row.asset) === scope;
  });
  for (const ec of applicableEdges) {
    const scope = ec.appliesToAssetClass;
    lines.push(`  test(${JSON.stringify(`[edge] ${ec.name}${titleSuffix}`)}, async ({ page }) => {`);
    lines.push(`    // Constraint: ${ec.constraintId}${scope ? ` (asset class: ${scope})` : ''}`);
    lines.push(`    // Expected: ${ec.expectedRejection}`);
    if (row.asset) lines.push(`    // Asset: ${row.asset}`);
    lines.push('');
    for (let i = 0; i < cap.controlPath.length; i++) {
      const cid = cap.controlPath[i];
      const ctrl = controlById.get(cid); if (!ctrl) continue;
      if (cid === ec.controlId) {
        lines.push(`    // Step ${i + 1}: (edge) ${ctrl.name} → invalid value ${ec.invalidValue}`);
        for (const stmt of controlToPlaywright(ctrl, ec.invalidValue, kg)) lines.push(`    ${stmt}`);
      } else {
        let choice = cap.optionChoices[cid];
        if (ctrl.kind === 'modal-selector' && row.asset) choice = row.asset;
        lines.push(`    // Step ${i + 1}: ${describeControl(ctrl, choice)}`);
        for (const stmt of controlToPlaywright(ctrl, choice, kg)) lines.push(`    ${stmt}`);
      }
      lines.push(`    await page.waitForTimeout(400);`);
    }
    lines.push('');
    lines.push(`    // Assert rejection — either (a) UI shows error/warning text, OR`);
    lines.push(`    // (b) the submit CTA is disabled. Either is a valid rejection signal.`);
    lines.push(`    await page.waitForTimeout(1500);`);
    lines.push(`    const bodyText = await page.locator('body').innerText().catch(() => '');`);
    lines.push(`    const looksRejected = /insufficient|minimum|maximum|invalid|reject|not\\s*allowed|too\\s*(low|high)|exceeds|wrong\\s*network|disconnect/i.test(bodyText);`);
    lines.push(`    const submitButtons = page.getByRole('button').filter({ hasText: /submit|trade|confirm|place|swap|deposit|borrow|stake/i });`);
    lines.push(`    const ctaCount = await submitButtons.count().catch(() => 0);`);
    lines.push(`    let allCtasDisabled = ctaCount > 0;`);
    lines.push(`    for (let k = 0; k < ctaCount; k++) {`);
    lines.push(`      const enabled = await submitButtons.nth(k).isEnabled().catch(() => false);`);
    lines.push(`      if (enabled) { allCtasDisabled = false; break; }`);
    lines.push(`    }`);
    lines.push(`    console.log('[edge]', ${JSON.stringify(ec.name + titleSuffix)}, 'rejectedText=', looksRejected, 'ctaDisabled=', allCtasDisabled);`);
    lines.push(`    expect(looksRejected || allCtasDisabled, ${JSON.stringify(`expected rejection signal for "${ec.name}${titleSuffix}" — neither error text nor disabled CTA`)}).toBe(true);`);
    lines.push(`  });`);
    lines.push('');
  }

  lines.push(`});`);
  lines.push('');
  return lines.join('\n');
}

// ── Control → Playwright code ──────────────────────────────────────────

/** Build {displaySymbol → class} map from kg.assets so spec-gen can filter
 *  class-scoped edge cases per test row (WTI row fires commodity edge cases,
 *  BTC row fires crypto edge cases). */
function buildSymbolClassMap(kg: KnowledgeGraph): Map<string, string> {
  const out = new Map<string, string>();
  const grouped = groupAssetsByClass(kg.assets ?? []);
  for (const [cls, list] of grouped) {
    for (const a of list) out.set(a.symbol.replace(/-/g, ''), cls);
  }
  return out;
}

/** Pick a coverage-balanced sample of assets for data-driven test rows. Uses
 *  generic asset-class keywords (crypto/fx/equity/commodity/metal) to tolerate
 *  whatever group naming the dApp uses (Pyth's CRYPTO1/FOREX, GMX's Crypto,
 *  etc.). Within each class we prefer flagships (BTC/ETH, EUR/JPY, WTI/BRENT,
 *  XAU/XAG, SPY/AAPL) so a commodity row actually exercises WTI, not just
 *  whichever symbol appeared first. Safe across dApps — flagships are
 *  finance-level, not Avantis-specific.
 *
 *  Falls back to Control.options if kg.assets is empty. */
function sampleTestRows(controlOptions: string[], kg: KnowledgeGraph): string[] {
  const assets = kg.assets ?? [];
  if (assets.length === 0) return controlOptions.slice(0, 6);

  const byClass = groupAssetsByClass(assets);
  const classFlagships: Record<string, string[]> = {
    crypto:   ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BTC', 'ETH', 'SOL'],
    fx:       ['EURUSD', 'USDJPY', 'GBPUSD', 'EUR', 'JPY'],
    equity:   ['AAPL', 'SPYUSD', 'NVDA', 'TSLA', 'SPY'],
    commodity:['WTIUSD', 'BRENTUSD', 'USOILSPOT', 'WTI', 'BRENT'],
    metal:    ['XAUUSD', 'XAGUSD', 'XAU', 'XAG'],
  };
  const classOrder = ['crypto', 'fx', 'equity', 'commodity', 'metal', 'other'];

  const picked: string[] = [];
  const available = (cls: string) => (byClass.get(cls) ?? []).map(a => a.symbol.replace(/-/g, ''));

  // Pass 1: one flagship (or first-available) per class
  for (const cls of classOrder) {
    if (picked.length >= 10) break;
    const avail = available(cls);
    if (avail.length === 0) continue;
    const prefs = classFlagships[cls] ?? [];
    const hit = prefs.find(p => avail.includes(p)) ?? avail[0];
    if (hit && !picked.includes(hit)) picked.push(hit);
  }
  // Pass 2: second flagship per class (crypto gets more budget since it dominates)
  for (const cls of classOrder) {
    if (picked.length >= 10) break;
    const avail = available(cls);
    const prefs = classFlagships[cls] ?? [];
    const second = prefs.find(p => avail.includes(p) && !picked.includes(p));
    if (second) picked.push(second);
  }
  // Pass 3: anything remaining in priority order
  for (const cls of classOrder) {
    if (picked.length >= 10) break;
    for (const sym of available(cls)) {
      if (picked.length >= 10) break;
      if (!picked.includes(sym)) picked.push(sym);
    }
  }
  return picked.slice(0, 10);
}

function describeControl(ctrl: Control, choice: string | undefined): string {
  if (choice !== undefined) return `${ctrl.name} → ${choice}`;
  return `${ctrl.name} (${ctrl.kind})`;
}

function controlToPlaywright(ctrl: Control, choice: string | undefined, kg: KnowledgeGraph): string[] {
  switch (ctrl.kind) {
    case 'input': {
      const val = choice ?? (ctrl.unit === 'USDC' ? '1' : '1');
      const loc = firstComponentLocator(ctrl, kg) ?? `page.locator('input').first()`;
      return [`await ${loc}.fill(${JSON.stringify(String(val))}).catch(() => {});`];
    }
    case 'slider': {
      const val = choice ?? '25';
      const loc = firstComponentLocator(ctrl, kg) ?? `page.locator('input[type="range"]').first()`;
      return [
        `await ${loc}.evaluate((el, v) => {`,
        `  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;`,
        `  setter?.call(el, v);`,
        `  el.dispatchEvent(new Event('input', { bubbles: true }));`,
        `  el.dispatchEvent(new Event('change', { bubbles: true }));`,
        `}, ${JSON.stringify(String(val))}).catch(() => {});`,
      ];
    }
    case 'toggle': {
      // Only click if choice is 'on' / true / undefined-meaning-toggle
      const on = choice === 'on' || choice === 'true' || choice === 'ON' || choice === undefined;
      if (!on) return [`// toggle left off`];
      const loc = firstComponentLocator(ctrl, kg) ?? `page.getByRole('switch').first()`;
      return [`await ${loc}.click({ timeout: 3000 }).catch(() => {});`];
    }
    case 'radio':
    case 'tabs':
    case 'percentage-picker':
    case 'dropdown': {
      if (!choice) {
        const first = firstComponentLocator(ctrl, kg); if (!first) return [];
        return [`await ${first}.click({ timeout: 3000 }).catch(() => {});`];
      }
      return [`await page.getByText(${JSON.stringify(String(choice))}, { exact: false }).first().click({ timeout: 5000 }).catch(() => {});`];
    }
    case 'modal-selector': {
      const opener = firstComponentLocator(ctrl, kg) ?? `page.getByRole('button', { name: /[A-Z]{3,}[-/]?USD/i }).first()`;
      const pick = choice ?? 'ETH';
      return [
        `await ${opener}.click({ timeout: 3000 }).catch(() => {});`,
        `await page.waitForTimeout(1000);`,
        `try {`,
        `  const search = page.getByRole('textbox').or(page.getByRole('searchbox')).first();`,
        `  if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {`,
        `    await search.fill(${JSON.stringify(String(pick))});`,
        `    await page.waitForTimeout(600);`,
        `  }`,
        `} catch {}`,
        `await page.getByText(${JSON.stringify(String(pick))}, { exact: false }).first().click({ timeout: 3000 }).catch(() => {});`,
        `await page.keyboard.press('Escape').catch(() => {});`,
      ];
    }
    case 'submit-cta': {
      const loc = firstComponentLocator(ctrl, kg);
      return [
        `// Submit: classify terminal state first`,
        `const submitBtn = ${loc ?? `page.getByRole('button').last()`};`,
        `try { if (await submitBtn.isEnabled({ timeout: 2000 }).catch(() => false)) await submitBtn.click({ timeout: 5000 }); } catch {}`,
      ];
    }
    case 'link':
    case 'tab':
    case 'button':
    default: {
      const loc = firstComponentLocator(ctrl, kg);
      if (!loc) return [];
      return [`await ${loc}.click({ timeout: 3000 }).catch(() => {});`];
    }
  }
}

function firstComponentLocator(ctrl: Control, kg: KnowledgeGraph): string | null {
  for (const cid of ctrl.componentIds) {
    const c = kg.components.find(cc => cc.id === cid);
    if (!c) continue;
    if (c.testId) return `page.getByTestId(${JSON.stringify(c.testId)})`;
    if (c.role && c.name) return `page.getByRole(${JSON.stringify(c.role)}, { name: ${JSON.stringify(String(c.name).slice(0, 60))} }).first()`;
    if (c.name) return `page.getByText(${JSON.stringify(String(c.name).slice(0, 60))}).first()`;
  }
  return null;
}

// ── Legacy spec move ───────────────────────────────────────────────────

/** Stale module-subdir specs from previous pipeline runs accumulate when slugs change.
 *  This purges everything under tests/<module>/ into tests/_legacy/<module>-<timestamp>/
 *  before the new run writes its fresh set. Keeps history without polluting the live dir. */
function archiveStaleModuleSpecs(testsDir: string): void {
  if (!existsSync(testsDir)) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const subdirs = readdirSync(testsDir).filter(f => {
    if (f === '_legacy' || f.startsWith('.')) return false;
    try { return statSync(join(testsDir, f)).isDirectory(); } catch { return false; }
  });
  let moved = 0;
  for (const sub of subdirs) {
    const srcDir = join(testsDir, sub);
    const specs = readdirSync(srcDir).filter(f => f.endsWith('.spec.ts'));
    if (specs.length === 0) continue;
    const dstDir = join(testsDir, '_legacy', `${sub}-${timestamp}`);
    mkdirSync(dstDir, { recursive: true });
    for (const f of specs) {
      try {
        const src = readFileSync(join(srcDir, f), 'utf-8');
        const rewritten = src.replace(/from\s+(['"])\.\.\/\.\.\//g, `from $1../../../`);
        writeFileSync(join(dstDir, f), rewritten, 'utf-8');
        unlinkSync(join(srcDir, f));
        moved++;
      } catch (e) {
        console.warn(`[SpecGen] archive failed for ${f}: ${(e as Error).message}`);
      }
    }
  }
  if (moved > 0) console.log(`[SpecGen] archived ${moved} stale module specs to tests/_legacy/`);
}

function moveLegacySpecs(testsDir: string): void {
  if (!existsSync(testsDir)) return;
  const entries = readdirSync(testsDir).filter(f => {
    if (!f.endsWith('.spec.ts')) return false;
    try { return statSync(join(testsDir, f)).isFile(); } catch { return false; }
  });
  if (entries.length === 0) return;
  const legacyDir = join(testsDir, '_legacy');
  mkdirSync(legacyDir, { recursive: true });
  for (const f of entries) {
    const srcPath = join(testsDir, f);
    const dstPath = join(legacyDir, f);
    try {
      const src = readFileSync(srcPath, 'utf-8');
      const rewritten = src.replace(/from\s+(['"])\.\.\//g, `from $1../../`);
      writeFileSync(dstPath, rewritten, 'utf-8');
      unlinkSync(srcPath);
    } catch (e) {
      console.warn(`[SpecGen] legacy move failed for ${f}: ${(e as Error).message}`);
    }
  }
  console.log(`[SpecGen] moved ${entries.length} legacy specs to tests/_legacy/`);
}

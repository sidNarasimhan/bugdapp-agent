/**
 * KG v2 Build — assembles the four-layer KG from upstream artifacts:
 * knowledge-graph.json + comprehension.json + structured-docs.json +
 * modules.json + controls.json + capabilities.json. Deterministic, no LLM.
 *
 * (Renamed from kg-migrate.ts — the file used to "migrate" from a v1 typed
 * graph that's been retired. It's now THE KG build step.)
 *
 * Note on inferenceSource strings: emitted nodes carry inferenceSource:
 * 'kg-migrate:*' as stable identifiers — kg-cleanup.ts greps for that
 * prefix to identify skeleton states the LLM-extractor superseded. Kept
 * as-is for KG-on-disk back-compat. Don't rename without coordinating
 * cleanup at the same time.
 *
 * What gets populated:
 *   L1 Structural — Pages + Components from v1 KG (lossless map).
 *   L2 Behavioral — Actions from each Capability's controlPath (one Action per
 *                   step). Skeleton States synthesised from preconditions
 *                   (REQUIRES_STATE), successCriteria (TRANSITIONS_TO end),
 *                   and EdgeCases (FAILS_TO error State per edge case).
 *                   Marked provenance='inferred', source='kg-migrate'.
 *   L3 Technical  — Skeleton ApiCall nodes from kg.apiEndpoints + skeleton
 *                   ContractCall nodes from kg.contracts. No bindings yet —
 *                   tech-binder.ts owns that.
 *   L4 Semantic   — One Flow per Capability bound by START_STATE/END_STATE +
 *                   INCLUDES_ACTION edges over the controlPath.
 *
 * Why "inferred": capabilities are themselves derived (graph traversal +
 * LLM names), so any state machine reconstructed from them is one inference
 * step further removed than what the crawler observed. state-extractor.ts
 * will replace these with observed/LLM-validated states.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, Capability, Control, KnowledgeGraph } from '../agent/state.js';
import {
  KGv2Builder, mintId, stamp, nowIso,
  type StructuralNode, type StateNode, type ActionNode, type FlowNode,
  type ApiCallNode, type ContractCallNode, type ComponentType, type ActionType,
  type StateConditions, type WalletContext,
  type DocSectionNode, type ConstraintNode, type AssetNode, type FeatureNode,
} from '../agent/kg-v2.js';
import type { StructuredDoc } from '../agent/state.js';

function deriveCrawlId(outputDir: string, url: string): string {
  // Hash of url + scraped-data mtime if present, else url + day-bucket.
  const scrapedPath = join(outputDir, 'scraped-data.json');
  if (existsSync(scrapedPath)) {
    try {
      const stat = require('fs').statSync(scrapedPath);
      return mintId('crawl', { url, mtime: stat.mtimeMs });
    } catch {}
  }
  return mintId('crawl', { url, day: new Date().toISOString().slice(0, 10) });
}

function compTypeFrom(role: string, name: string): ComponentType {
  const r = role.toLowerCase();
  const n = name.toLowerCase();
  if (r === 'switch') return 'toggle';
  if (r === 'tab') return 'tab';
  if (r === 'combobox' || r === 'option') return 'select';
  if (r === 'spinbutton' || r === 'textbox' || r === 'slider') return 'input';
  if (r === 'link') return 'nav-link';
  if (r === 'button') {
    if (/submit|place|trade|swap|deposit|stake|approve|borrow|repay|confirm/i.test(n)) return 'transaction-button';
    if (/select|choose|pick|asset|token/i.test(n)) return 'modal-trigger';
    return 'other';
  }
  return 'other';
}

function controlKindToActionType(kind: Control['kind']): ActionType {
  switch (kind) {
    case 'input':              return 'input';
    case 'slider':             return 'input';
    case 'toggle':             return 'click';
    case 'radio':              return 'click';
    case 'tabs':               return 'click';
    case 'percentage-picker':  return 'click';
    case 'dropdown':           return 'select';
    case 'modal-selector':     return 'select';
    case 'submit-cta':         return 'wallet-sign';
    case 'link':               return 'navigate';
    case 'tab':                return 'click';
    case 'button':             return 'click';
    default:                   return 'click';
  }
}

/** Parse a free-text precondition string into structured conditions. Best-
 *  effort — anything we can't parse is dumped into `notes`. */
function parsePrecondition(text: string): StateConditions {
  const t = text.toLowerCase();
  const c: StateConditions = { visibleIndicators: [] };
  if (/wallet.*connect|connect.*wallet/.test(t))   c.walletStatus = 'connected';
  else if (/disconnect|no wallet/.test(t))          c.walletStatus = 'disconnected';
  if (/wrong.*network|switch.*network/.test(t))    c.walletStatus = 'wrong-network';
  if (/balance|fund|usdc|eth|deposit/.test(t))     c.balanceRange = { min: 0.000001 };
  if (/position/.test(t) && /open/.test(t))        c.positionStatus = 'open';
  c.notes = text;
  return c;
}

function parseEdgeCaseToErrorState(ec: Capability['edgeCases'][number]): StateConditions {
  return {
    notes: `${ec.name} — expected: ${ec.expectedRejection}`,
    visibleIndicators: [ec.expectedRejection.slice(0, 80)],
  };
}

export interface MigrateResult {
  kgV2Path: string;
  nodeCount: number;
  edgeCount: number;
}

/** Builds kg-v2.json from upstream sidecars. Deterministic, no LLM.
 *  Emitted nodes still carry inferenceSource: 'kg-migrate:*' as the stable
 *  identifier kg-cleanup keys on — kept for KG-on-disk back-compat. */
export function createKGBuildNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType> & { kgBuild?: MigrateResult }> => {
    const { config, knowledgeGraph: kg } = state;
    const url = config.url;
    const outDir = config.outputDir;
    const crawlId = deriveCrawlId(outDir, url);
    const observedAt = nowIso();

    console.log(`━━━ KG Migrate (v1 → v2): crawl=${crawlId} ━━━`);

    const b = new KGv2Builder(url, crawlId);

    // Hydrate from disk fallbacks (mirrors spec-gen.ts behaviour).
    const caps: Capability[] = state.capabilities?.length
      ? state.capabilities
      : (() => { const p = join(outDir, 'capabilities.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const controls: Control[] = state.controls?.length
      ? state.controls
      : (() => { const p = join(outDir, 'controls.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const controlById = new Map(controls.map(c => [c.id, c]));

    // ── L1 Structural ────────────────────────────────────────────────────
    // Pages
    const pageV1ToV2 = new Map<string, string>();  // legacy id → v2 id
    for (const p of kg.pages ?? []) {
      const id = mintId('page', { url: p.url, route: p.url, name: p.name });
      pageV1ToV2.set(p.id, id);
      const node: StructuralNode = {
        ...stamp({ id, crawlId, provenance: 'observed', observedAt }),
        layer: 'structural', kind: 'page',
        label: p.name, routePattern: p.url, legacyV1Id: p.id,
      };
      b.addNode(node);
    }
    // Components
    const compV1ToV2 = new Map<string, string>();
    for (const c of kg.components ?? []) {
      const stableProps = { selector: c.selector || '', role: c.role, name: c.name, pageId: c.pageId };
      const id = mintId('component', stableProps);
      compV1ToV2.set(c.id, id);
      const node: StructuralNode = {
        ...stamp({ id, crawlId, provenance: 'observed', observedAt }),
        layer: 'structural', kind: 'component',
        label: c.name || `(unnamed ${c.role})`,
        selector: c.selector,
        componentType: compTypeFrom(c.role, c.name),
        testId: c.testId,
        stableAttrs: { role: c.role },
        legacyV1Id: c.id,
      };
      b.addNode(node);
      // page CONTAINS component
      const pageV2 = pageV1ToV2.get(c.pageId);
      if (pageV2) {
        const eid = mintId('edge', { from: pageV2, to: id, t: 'CONTAINS' });
        b.addEdge({
          ...stamp({ id: eid, crawlId, provenance: 'observed', observedAt }),
          from: pageV2, to: id, edgeType: 'CONTAINS',
        });
      }
    }

    // ── L3 Technical (skeletons — tech-binder fills the rest) ────────────
    for (const api of kg.apiEndpoints ?? []) {
      const id = mintId('apiCall', { path: api.path });
      const node: ApiCallNode = {
        ...stamp({ id, crawlId, provenance: 'observed', observedAt, inferenceSource: 'kg-migrate:from-apiEndpoint' }),
        layer: 'technical', kind: 'apiCall',
        method: 'GET',
        urlPattern: api.path,
        responseSchema: api.sampleKeys?.length ? { topLevelKeys: api.sampleKeys } : undefined,
      };
      b.addNode(node);
    }
    for (const co of kg.contracts ?? []) {
      const id = mintId('contractCall', { addr: co.address, role: co.role });
      const node: ContractCallNode = {
        ...stamp({ id, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:from-contractList' }),
        layer: 'technical', kind: 'contractCall',
        contractAddress: co.address.toLowerCase(),
        chainId: co.chainId,
        functionSignature: 'unknown()',  // tech-binder populates
        expectedEventIds: [],
      };
      b.addNode(node);
    }

    // ── L4 Semantic — Docs, Constraints, Assets, Features ───────────────
    // Pull from richer structured-docs.json if present, else fall back to
    // raw v1 kg.docSections.
    const sdPath = join(outDir, 'structured-docs.json');
    const structuredDocs: StructuredDoc[] = existsSync(sdPath)
      ? JSON.parse(readFileSync(sdPath, 'utf-8'))
      : [];
    const docMap = new Map<string, string>();   // legacy doc id → v2 id
    if (structuredDocs.length > 0) {
      for (const d of structuredDocs) {
        const id = mintId('docSection', { legacyId: d.id, title: d.title });
        docMap.set(d.id, id);
        const node: DocSectionNode = {
          ...stamp({ id, crawlId, provenance: 'observed', observedAt, inferenceSource: 'kg-migrate:structured-docs' }),
          layer: 'semantic', kind: 'docSection',
          title: d.title,
          content: (d.content ?? '').slice(0, 800),  // cap to keep KG file bounded
          topics: d.topics ?? [],
          rules: d.rules ?? [],
        };
        b.addNode(node);
      }
    } else {
      for (const d of kg.docSections ?? []) {
        const id = mintId('docSection', { legacyId: d.id, title: d.title });
        docMap.set(d.id, id);
        const node: DocSectionNode = {
          ...stamp({ id, crawlId, provenance: 'observed', observedAt, inferenceSource: 'kg-migrate:from-docSection' }),
          layer: 'semantic', kind: 'docSection',
          title: d.title,
          content: (d.content ?? '').slice(0, 800),
          topics: [],
          rules: [],
        };
        b.addNode(node);
      }
    }

    // Constraints
    const constraintMap = new Map<string, string>();
    for (const c of kg.constraints ?? []) {
      const id = mintId('constraint', { legacyId: c.id, name: c.name, value: c.value });
      constraintMap.set(c.id, id);
      const node: ConstraintNode = {
        ...stamp({ id, crawlId, provenance: c.source === 'docs' ? 'observed' : 'inferred', observedAt, inferenceSource: `kg-migrate:from-constraint:${c.source}` }),
        layer: 'semantic', kind: 'constraint',
        label: c.name,
        value: c.value,
        scope: c.scope,
        testImplication: c.testImplication,
        source: c.source as ConstraintNode['source'],
      };
      b.addNode(node);
    }

    // Assets — coarse class derived from group string for cross-dApp compatibility.
    const assetClassFromGroup = (g: string): string | undefined => {
      const G = g.toUpperCase();
      if (/CRYPTO/.test(G)) return 'crypto';
      if (/FOREX|FX/.test(G)) return 'fx';
      if (/EQUIT|STOCK|SHARE/.test(G)) return 'equity';
      if (/COMMOD|OIL|GAS/.test(G)) return 'commodity';
      if (/METAL|GOLD|SILVER/.test(G)) return 'metal';
      return undefined;
    };
    for (const a of kg.assets ?? []) {
      const id = mintId('asset', { symbol: a.symbol, group: a.group });
      const node: AssetNode = {
        ...stamp({ id, crawlId, provenance: 'observed', observedAt, inferenceSource: 'kg-migrate:from-asset' }),
        layer: 'semantic', kind: 'asset',
        symbol: a.symbol,
        group: a.group,
        assetClass: assetClassFromGroup(a.group),
        maxLeverage: a.maxLeverage,
        minCollateral: a.minCollateral,
        tradingHours: a.tradingHours,
      };
      b.addNode(node);
    }

    // Features
    for (const f of kg.features ?? []) {
      const id = mintId('feature', { name: f.name });
      const node: FeatureNode = {
        ...stamp({ id, crawlId, provenance: 'observed', observedAt, inferenceSource: 'kg-migrate:from-feature' }),
        layer: 'semantic', kind: 'feature',
        name: f.name,
        description: f.description,
        constraints: f.constraints,
      };
      b.addNode(node);
      // Page → EXPOSES_FEATURE → feature, when the feature was crawled with a pageId
      if (f.pageId) {
        const pv2 = pageV1ToV2.get(f.pageId);
        if (pv2) {
          b.addEdge({
            ...stamp({ id: mintId('edge', { from: pv2, to: id, t: 'EXPOSES_FEATURE' }), crawlId, provenance: 'observed', observedAt }),
            from: pv2, to: id, edgeType: 'EXPOSES_FEATURE',
          });
        }
      }
    }

    // ── L2 + L4 from Capabilities ────────────────────────────────────────
    let actionCount = 0, stateCount = 0, flowCount = 0, errorStateCount = 0;
    for (const cap of caps) {
      // Initial state — collapse ALL preconditions into one state's conditions
      // so we don't synthesise N orphan precondition states (validator E3).
      // The state-extractor LLM phase replaces this with a real state machine.
      const mergedPreconds: StateConditions = cap.preconditions.length
        ? cap.preconditions.reduce<StateConditions>((acc, p) => {
            const c = parsePrecondition(p);
            if (c.walletStatus) acc.walletStatus = c.walletStatus;
            if (c.balanceRange) acc.balanceRange = { ...(acc.balanceRange ?? {}), ...c.balanceRange };
            if (c.positionStatus) acc.positionStatus = c.positionStatus;
            acc.visibleIndicators = [...(acc.visibleIndicators ?? []), p];
            return acc;
          }, { visibleIndicators: [] })
        : { walletStatus: 'disconnected', notes: 'default initial' };
      mergedPreconds.notes = cap.preconditions.length
        ? cap.preconditions.join(' AND ')
        : 'default initial';
      const initId = mintId('state', { capId: cap.id, kind: 'init', cond: mergedPreconds });
      const initState: StateNode = {
        ...stamp({ id: initId, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:precondition' }),
        layer: 'behavioral', kind: 'state',
        label: cap.preconditions[0] ?? `${cap.name}: initial`,
        conditions: mergedPreconds,
        isInitial: true,
      };
      b.addNode(initState);
      stateCount++;
      const preStateIds: string[] = [initId];

      // Success / end state from successCriteria.
      const endCond: StateConditions = {
        notes: cap.successCriteria || `${cap.name}: completed`,
        visibleIndicators: cap.successCriteria ? [cap.successCriteria.slice(0, 80)] : [],
      };
      const endId = mintId('state', { capId: cap.id, kind: 'success', cond: endCond });
      const endState: StateNode = {
        ...stamp({ id: endId, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:successCriteria' }),
        layer: 'behavioral', kind: 'state',
        label: cap.successCriteria ? cap.successCriteria.slice(0, 100) : `${cap.name}: success`,
        conditions: endCond,
      };
      b.addNode(endState);
      stateCount++;

      // Actions per controlPath step.
      const actionIds: string[] = [];
      let prevStateId = preStateIds[preStateIds.length - 1];
      for (let i = 0; i < cap.controlPath.length; i++) {
        const ctrlId = cap.controlPath[i];
        const ctrl = controlById.get(ctrlId);
        if (!ctrl) continue;
        const choice = cap.optionChoices[ctrlId];
        const aid = mintId('action', { capId: cap.id, ctrlId, i, choice: choice ?? null });
        const action: ActionNode = {
          ...stamp({ id: aid, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:capability' }),
          layer: 'behavioral', kind: 'action',
          label: choice !== undefined ? `${ctrl.name} → ${choice}` : ctrl.name,
          actionType: controlKindToActionType(ctrl.kind),
          inputValue: choice !== undefined ? String(choice) : undefined,
        };
        b.addNode(action);
        actionIds.push(aid);
        actionCount++;

        // REQUIRES_STATE: action requires the previous state.
        b.addEdge({
          ...stamp({ id: mintId('edge', { from: aid, to: prevStateId, t: 'REQUIRES_STATE' }), crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate' }),
          from: aid, to: prevStateId, edgeType: 'REQUIRES_STATE',
        });

        // Per-step intermediate state (anonymous — keeps the chain). Last step's
        // successor is the cap's endState.
        const isLast = i === cap.controlPath.length - 1;
        const nextStateId = isLast ? endId : mintId('state', { capId: cap.id, kind: 'mid', i });
        if (!isLast) {
          const midState: StateNode = {
            ...stamp({ id: nextStateId, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:intermediate' }),
            layer: 'behavioral', kind: 'state',
            label: `after ${ctrl.name}`,
            conditions: { notes: `intermediate state after step ${i + 1}` },
          };
          b.addNode(midState);
          stateCount++;
        }
        // TRANSITIONS_TO: action transitions to the next state.
        b.addEdge({
          ...stamp({ id: mintId('edge', { from: aid, to: nextStateId, t: 'TRANSITIONS_TO' }), crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate' }),
          from: aid, to: nextStateId, edgeType: 'TRANSITIONS_TO',
        });

        // PERFORMED_VIA: action bound to v2 component (best-effort by legacy id).
        for (const v1cid of ctrl.componentIds) {
          const v2cid = compV1ToV2.get(v1cid);
          if (!v2cid) continue;
          b.addEdge({
            ...stamp({ id: mintId('edge', { from: aid, to: v2cid, t: 'PERFORMED_VIA' }), crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate' }),
            from: aid, to: v2cid, edgeType: 'PERFORMED_VIA',
          });
        }

        prevStateId = nextStateId;
      }

      // Universal failure mode: every wallet-sign action can be rejected by
      // the user in the wallet popup. Emit a synthetic FAILS_TO so the
      // validator's W1 (action without failure modes) reflects real coverage
      // gaps, not just "user can always reject" hand-waving.
      for (let i = 0; i < cap.controlPath.length; i++) {
        const aid = actionIds[i];
        if (!aid) continue;
        const action = b.nodes.get(aid);
        if (!action || action.kind !== 'action' || (action as ActionNode).actionType !== 'wallet-sign') continue;
        const errCond: StateConditions = { notes: 'User rejected the transaction in the wallet popup', visibleIndicators: ['User rejected', 'Transaction declined'] };
        const errId = mintId('state', { capId: cap.id, aid, kind: 'wallet-rejected' });
        b.addNode({
          ...stamp({ id: errId, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:wallet-rejected-default' }),
          layer: 'behavioral', kind: 'state', label: 'WalletPopup_UserRejected',
          conditions: errCond, isError: true,
        });
        errorStateCount++;
        b.addEdge({
          ...stamp({ id: mintId('edge', { from: aid, to: errId, t: 'FAILS_TO', kind: 'wallet-rejected' }), crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate' }),
          from: aid, to: errId, edgeType: 'FAILS_TO', label: 'user rejects in wallet popup',
        });
      }

      // Edge cases → error states + FAILS_TO edges from the targeted action.
      for (const ec of cap.edgeCases) {
        const errCond = parseEdgeCaseToErrorState(ec);
        const errId = mintId('state', { capId: cap.id, ecId: ec.id, kind: 'error' });
        const errState: StateNode = {
          ...stamp({ id: errId, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:edgeCase' }),
          layer: 'behavioral', kind: 'state',
          label: ec.name,
          conditions: errCond,
          isError: true,
        };
        b.addNode(errState);
        errorStateCount++;

        // Find the action in this cap whose source control matches ec.controlId.
        const targetIdx = cap.controlPath.indexOf(ec.controlId);
        if (targetIdx >= 0 && actionIds[targetIdx]) {
          const aid = actionIds[targetIdx];
          b.addEdge({
            ...stamp({ id: mintId('edge', { from: aid, to: errId, t: 'FAILS_TO', invalid: ec.invalidValue }), crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:edgeCase' }),
            from: aid, to: errId, edgeType: 'FAILS_TO',
            label: `invalid: ${ec.invalidValue}`,
          });
        } else if (actionIds.length > 0) {
          // Fall back to the submit-cta (last action) for unscoped edges
          // (wrong-network, unconnected).
          const aid = actionIds[actionIds.length - 1];
          b.addEdge({
            ...stamp({ id: mintId('edge', { from: aid, to: errId, t: 'FAILS_TO', invalid: ec.invalidValue, fb: 1 }), crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:edgeCase-fallback' }),
            from: aid, to: errId, edgeType: 'FAILS_TO',
            label: `invalid: ${ec.invalidValue}`,
          });
        }
      }

      // L4 Flow.
      const flowId = mintId('flow', { capId: cap.id });
      const linkedDocV2Ids = (cap.docIds ?? [])
        .map(did => docMap.get(did))
        .filter((x): x is string => Boolean(x));
      const flow: FlowNode = {
        ...stamp({ id: flowId, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:capability' }),
        layer: 'semantic', kind: 'flow',
        label: cap.name,
        description: cap.intent || cap.name,
        startStateId: initId,
        endStateId: endId,
        actionIds,
        docSectionIds: linkedDocV2Ids,
        archetype: cap.archetype,
        legacyCapabilityId: cap.id,
      };
      b.addNode(flow);
      flowCount++;
      // DESCRIBED_BY edges flow → docSection
      for (const dvid of linkedDocV2Ids) {
        b.addEdge({
          ...stamp({ id: mintId('edge', { from: flowId, to: dvid, t: 'DESCRIBED_BY' }), crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:cap-docIds' }),
          from: flowId, to: dvid, edgeType: 'DESCRIBED_BY',
        });
      }
      // CONSTRAINS edges constraint → action (via cap.constraintIds + edge-case constraint refs)
      const consIds = new Set<string>([...(cap.constraintIds ?? []), ...cap.edgeCases.map(ec => ec.constraintId).filter(Boolean)]);
      for (const cid of consIds) {
        const cv2 = constraintMap.get(cid);
        if (!cv2) continue;
        // Constrain the submit-cta action (last action) by default.
        const lastAid = actionIds[actionIds.length - 1];
        if (!lastAid) continue;
        b.addEdge({
          ...stamp({ id: mintId('edge', { from: cv2, to: lastAid, t: 'CONSTRAINS' }), crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:cap-constraintIds' }),
          from: cv2, to: lastAid, edgeType: 'CONSTRAINS',
        });
      }
      // OPERATES_ON edges flow → asset. Asset-picking is data-driven
      // (spec-gen iterates assets at test-row time), so it's NEVER set in
      // cap.optionChoices for trading flows. Instead: if any control in
      // the flow's path is a modal-selector AND has options[], link the
      // flow to EVERY asset whose symbol matches one of those options.
      // This is what the brief calls "asset metadata is queryable per flow".
      const modalCtrl = cap.controlPath
        .map(cid => controlById.get(cid))
        .find(c => c?.kind === 'modal-selector' && Array.isArray(c?.options) && c!.options!.length > 1);
      if (modalCtrl?.options?.length) {
        const optionSyms = new Set(modalCtrl.options.map(o => o.replace(/[-/\s]/g, '').toUpperCase()));
        for (const a of kg.assets ?? []) {
          const sym = a.symbol.replace(/[-/\s]/g, '').toUpperCase();
          if (!optionSyms.has(sym)) continue;
          const aid2 = mintId('asset', { symbol: a.symbol, group: a.group });
          b.addEdge({
            ...stamp({ id: mintId('edge', { from: flowId, to: aid2, t: 'OPERATES_ON' }), crawlId, provenance: 'inferred', observedAt, inferenceSource: 'kg-migrate:modal-options' }),
            from: flowId, to: aid2, edgeType: 'OPERATES_ON',
          });
        }
      }
      b.addEdge({
        ...stamp({ id: mintId('edge', { from: flowId, to: initId, t: 'START_STATE' }), crawlId, provenance: 'inferred', observedAt }),
        from: flowId, to: initId, edgeType: 'START_STATE',
      });
      b.addEdge({
        ...stamp({ id: mintId('edge', { from: flowId, to: endId, t: 'END_STATE' }), crawlId, provenance: 'inferred', observedAt }),
        from: flowId, to: endId, edgeType: 'END_STATE',
      });
      for (const aid of actionIds) {
        b.addEdge({
          ...stamp({ id: mintId('edge', { from: flowId, to: aid, t: 'INCLUDES_ACTION' }), crawlId, provenance: 'inferred', observedAt }),
          from: flowId, to: aid, edgeType: 'INCLUDES_ACTION',
        });
      }
    }

    const out = b.serialize();
    // Persist as latest + versioned snapshot.
    const v2Dir = join(outDir, 'kg-v2');
    mkdirSync(v2Dir, { recursive: true });
    const versionedPath = join(v2Dir, `kg-v2.${crawlId.replace(/[^a-z0-9]/gi, '_')}.json`);
    const latestPath = join(outDir, 'kg-v2.json');

    // SAFETY: if the existing kg-v2.json on disk has state-extractor or
    // explorer enrichment, snapshot it before overwriting so we never silently
    // destroy LLM work paid for in credits. The snapshot lives next to the
    // versioned ones and is named so it's obvious which run produced it.
    if (existsSync(latestPath)) {
      try {
        const existing = JSON.parse(readFileSync(latestPath, 'utf-8'));
        const hasLLMEnrichment = (existing.nodes ?? []).some((n: any) =>
          typeof n?.inferenceSource === 'string' &&
          (n.inferenceSource.startsWith('state-extractor') || n.inferenceSource.startsWith('explorer'))
        );
        if (hasLLMEnrichment) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupPath = join(v2Dir, `kg-v2.pre-rebuild-${stamp}.json`);
          writeFileSync(backupPath, JSON.stringify(existing, null, 2));
          console.log(`[kg-build] SAFETY: existing kg-v2.json has LLM enrichment — snapshotted to ${backupPath}`);
        }
      } catch (e: any) {
        console.warn(`[kg-build] could not inspect existing kg-v2.json for safety snapshot: ${e?.message ?? e}`);
      }
    }

    writeFileSync(versionedPath, JSON.stringify(out, null, 2));
    writeFileSync(latestPath, JSON.stringify(out, null, 2));

    console.log(`[kg-build] L1: ${b.byKind('page').length}p ${b.byKind('component').length}c | L2: ${actionCount}a ${stateCount}s (${errorStateCount} error) | L3: ${b.byKind('apiCall').length}api ${b.byKind('contractCall').length}contract | L4: ${flowCount}flow ${b.byKind('docSection').length}doc ${b.byKind('constraint').length}constraint ${b.byKind('asset').length}asset ${b.byKind('feature').length}feature`);
    console.log(`[kg-build] wrote ${out.nodes.length} nodes + ${out.edges.length} edges → ${latestPath}`);

    return {
      kgBuild: {
        kgV2Path: latestPath,
        nodeCount: out.nodes.length,
        edgeCount: out.edges.length,
      },
    };
  };
}

/** Standalone load helper used by downstream phases. */
export function loadKGv2(outputDir: string): KGv2Builder | null {
  const p = join(outputDir, 'kg-v2.json');
  if (!existsSync(p)) return null;
  const data = JSON.parse(readFileSync(p, 'utf-8'));
  return KGv2Builder.load(data);
}

/** Persist updated builder back to latest + new version snapshot. */
export function saveKGv2(b: KGv2Builder, outputDir: string, snapshotTag?: string): string {
  const out = b.serialize();
  const latestPath = join(outputDir, 'kg-v2.json');
  writeFileSync(latestPath, JSON.stringify(out, null, 2));
  if (snapshotTag) {
    const v2Dir = join(outputDir, 'kg-v2');
    mkdirSync(v2Dir, { recursive: true });
    writeFileSync(join(v2Dir, `kg-v2.${snapshotTag}.json`), JSON.stringify(out, null, 2));
  }
  return latestPath;
}

// silence unused-import warnings under strict TS
const _wcRef: WalletContext | undefined = undefined; void _wcRef;

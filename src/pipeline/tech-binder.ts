/**
 * Tech Binder — enriches the v2 KG's technical layer (ApiCall / ContractCall /
 * Event) and binds it to behavioral Actions via TRIGGERS_API_CALL /
 * INVOKES_CONTRACT_CALL / EMITS_EVENT / RETURNS_ERROR. Deterministic, no LLM.
 *
 * Sources:
 *   - <outputDir>/network-raw-apis.json (observed network calls + payload samples)
 *   - <outputDir>/bundle-analysis.json (apiEndpoints + errorMessages)
 *   - kg.contracts (contract addresses + role) + COMMON_EVENT_ABI from
 *     src/chain/abi-registry (well-known event signatures by archetype)
 *
 * Bindings (all heuristic — flagged inferenceSource so validator can downgrade):
 *   - api: keyword match between Action.label and ApiCall.urlPattern segments
 *   - contract: Action.actionType === 'wallet-sign' AND archetype keyword in
 *     contract.role → INVOKES_CONTRACT_CALL → EMITS_EVENT (best-fit event from
 *     archetype event set)
 *   - errors: top errorMessages from bundle-analysis emit ErrorResponseNodes;
 *     RETURNS_ERROR edges from API/contract calls when keywords match
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentStateType } from '../agent/state.js';
import {
  KGv2Builder, mintId, stamp, nowIso,
  type ApiCallNode, type ContractCallNode, type EventNode, type ErrorResponseNode,
  type ActionNode,
} from '../agent/kg-v2.js';
import { loadKGv2, saveKGv2 } from './kg-migrate.js';

interface NetworkSample {
  method?: string;
  status?: number;
  request?: { headers?: Record<string, string>; body?: unknown };
  response?: { body?: unknown; latencyMs?: number };
}

/** Recursively map a sample value to a loose schema descriptor.
 *  Returns:  { type, properties? | items? }   for objects/arrays
 *            { type: 'string'|'number'|'boolean'|'null' } for primitives. */
function inferSchema(v: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return { type: 'unknown' };
  if (v === null) return { type: 'null' };
  if (Array.isArray(v)) return { type: 'array', items: v.length ? inferSchema(v[0], depth + 1) : { type: 'unknown' } };
  if (typeof v === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as object)) props[k] = inferSchema(val, depth + 1);
    return { type: 'object', properties: props };
  }
  return { type: typeof v };
}

/** Pull out a usable url-pattern from a raw network entry key. */
function normalizeUrlPattern(raw: string): string {
  // Strip protocol + host so ids are stable across environments.
  try {
    const u = new URL(raw);
    return u.pathname + (u.search ? '?' : '');
  } catch {
    return raw.startsWith('/') ? raw : `/${raw}`;
  }
}

/** Archetype-keyed event templates. Mirrors COMMON_EVENT_ABI grouping. */
const ARCHETYPE_EVENTS: Record<string, { sig: string; params: { name: string; type: string; indexed: boolean }[] }[]> = {
  token: [
    { sig: 'Transfer(address,address,uint256)', params: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ]},
    { sig: 'Approval(address,address,uint256)', params: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ]},
  ],
  pool: [
    { sig: 'Swap(address,address,int256,int256,uint160,uint128,int24)', params: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount0', type: 'int256', indexed: false },
      { name: 'amount1', type: 'int256', indexed: false },
    ]},
  ],
  lending: [
    { sig: 'Supply(address,address,address,uint256,uint16)', params: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: false },
      { name: 'onBehalfOf', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ]},
    { sig: 'Borrow(address,address,address,uint256,uint8,uint256,uint16)', params: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ]},
    { sig: 'Repay(address,address,address,uint256,bool)', params: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ]},
  ],
  perps: [
    { sig: 'TradeOpened(address,uint256,address,uint256,uint256,bool,uint256)', params: [
      { name: 'trader', type: 'address', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'collateral', type: 'uint256', indexed: false },
      { name: 'leverage', type: 'uint256', indexed: false },
      { name: 'isLong', type: 'bool', indexed: false },
    ]},
    { sig: 'TradeClosed(address,uint256,uint256,int256)', params: [
      { name: 'trader', type: 'address', indexed: true },
      { name: 'tradeId', type: 'uint256', indexed: true },
      { name: 'pnl', type: 'int256', indexed: false },
    ]},
  ],
};

/** Map a contract.role string to one of the archetype keys above. */
function roleToArchetype(role?: string): keyof typeof ARCHETYPE_EVENTS | null {
  if (!role) return null;
  const r = role.toLowerCase();
  if (r.includes('token') || r === 'erc20')  return 'token';
  if (r.includes('pool') || r.includes('router') || r.includes('swap')) return 'pool';
  if (r.includes('lending') || r.includes('aave') || r.includes('compound')) return 'lending';
  if (r.includes('perp') || r.includes('trading') || r.includes('vault')) return 'perps';
  return null;
}

/** Heuristic: do these two strings share at least one meaningful token? */
function keywordOverlap(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4 && !STOP.has(t));
  const ta = new Set(norm(a));
  for (const t of norm(b)) if (ta.has(t)) return true;
  return false;
}
const STOP = new Set(['button','click','select','open','close','dapp','user','page','submit','confirm','wallet','status','init']);

export function createTechBinderNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config, knowledgeGraph: kg } = state;
    const outDir = config.outputDir;

    const b = loadKGv2(outDir);
    if (!b) {
      console.log('[tech-binder] no kg-v2.json — run kg-migrate first. Skipping.');
      return {};
    }
    console.log('━━━ Tech Binder ━━━');
    const observedAt = nowIso();
    const crawlId = b.crawlId;

    // ── Enrich ApiCalls from network-raw-apis ─────────────────────────────
    const rawApisPath = join(outDir, 'network-raw-apis.json');
    let raw: Record<string, unknown> = {};
    if (existsSync(rawApisPath)) {
      try { raw = JSON.parse(readFileSync(rawApisPath, 'utf-8')); } catch { raw = {}; }
    }
    let apiEnriched = 0;
    for (const [rawKey, rawValRaw] of Object.entries(raw)) {
      const path = normalizeUrlPattern(rawKey);
      const id = mintId('apiCall', { path });
      const sample = (rawValRaw && typeof rawValRaw === 'object') ? rawValRaw as NetworkSample : {};
      const reqSchema = sample.request?.body !== undefined ? inferSchema(sample.request.body) : undefined;
      const respSchema = sample.response?.body !== undefined ? inferSchema(sample.response.body) : undefined;
      const node: ApiCallNode = {
        ...stamp({ id, crawlId, provenance: 'observed', observedAt, inferenceSource: 'tech-binder:network-raw-apis' }),
        layer: 'technical', kind: 'apiCall',
        method: sample.method ?? 'GET',
        urlPattern: path,
        requestSchema: reqSchema,
        responseSchema: respSchema,
        expectedStatusCodes: sample.status ? [sample.status] : undefined,
        expectedLatencyMs: sample.response?.latencyMs ? { min: sample.response.latencyMs * 0.5, max: sample.response.latencyMs * 2 } : undefined,
      };
      b.addNode(node);
      apiEnriched++;
    }

    // Fold in bundle-analysis.json's apiEndpoints[] (path-only, lower confidence).
    const bundlePath = join(outDir, 'bundle-analysis.json');
    let bundle: { apiEndpoints?: string[]; errorMessages?: string[] } = {};
    if (existsSync(bundlePath)) {
      try { bundle = JSON.parse(readFileSync(bundlePath, 'utf-8')); } catch {}
    }
    let apiFromBundle = 0;
    for (const ep of bundle.apiEndpoints ?? []) {
      const path = normalizeUrlPattern(ep);
      const id = mintId('apiCall', { path });
      if (b.nodes.has(id)) continue;
      const node: ApiCallNode = {
        ...stamp({ id, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'tech-binder:bundle-analysis' }),
        layer: 'technical', kind: 'apiCall',
        method: 'GET',
        urlPattern: path,
      };
      b.addNode(node);
      apiFromBundle++;
    }

    // ── Enrich ContractCalls + emit Events ────────────────────────────────
    let contractEnriched = 0, eventsEmitted = 0;
    for (const co of kg.contracts ?? []) {
      const arche = roleToArchetype(co.role);
      const cid = mintId('contractCall', { addr: co.address, role: co.role });
      const cc = b.nodes.get(cid);
      if (!cc || cc.kind !== 'contractCall') continue;
      const events = arche ? ARCHETYPE_EVENTS[arche] : [];
      const eventIds: string[] = [];
      for (const ev of events) {
        const eid = mintId('event', { addr: co.address, sig: ev.sig });
        const enode: EventNode = {
          ...stamp({ id: eid, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'tech-binder:archetype-event-template' }),
          layer: 'technical', kind: 'event',
          contractAddress: co.address.toLowerCase(),
          signature: ev.sig,
          params: ev.params,
        };
        b.addNode(enode);
        eventIds.push(eid);
        eventsEmitted++;
        // ContractCall EMITS_EVENT
        b.addEdge({
          ...stamp({ id: mintId('edge', { from: cid, to: eid, t: 'EMITS_EVENT' }), crawlId, provenance: 'inferred', observedAt }),
          from: cid, to: eid, edgeType: 'EMITS_EVENT',
        });
      }
      // Mutate the contract call's expectedEventIds + functionSignature inline
      // (preserves stable id, populates schema).
      (cc as ContractCallNode).expectedEventIds = eventIds;
      if (arche === 'token')   (cc as ContractCallNode).functionSignature = 'transfer(address,uint256)';
      if (arche === 'pool')    (cc as ContractCallNode).functionSignature = 'swap(uint256,uint256,address,bytes)';
      if (arche === 'lending') (cc as ContractCallNode).functionSignature = 'supply(address,uint256,address,uint16)';
      if (arche === 'perps')   (cc as ContractCallNode).functionSignature = 'openTrade(...)';
      contractEnriched++;
    }

    // ── ErrorResponse nodes from bundle errorMessages (top 50 only) ──────
    let errorNodes = 0;
    for (const msg of (bundle.errorMessages ?? []).slice(0, 50)) {
      const eid = mintId('errorResponse', { msg: msg.slice(0, 120) });
      const node: ErrorResponseNode = {
        ...stamp({ id: eid, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'tech-binder:bundle-errorMessages' }),
        layer: 'technical', kind: 'errorResponse',
        origin: /transaction|gas|nonce|chain|wallet|metamask/i.test(msg) ? 'wallet'
              : /revert|abi|bytes|address/i.test(msg) ? 'contract'
              : 'api',
        triggerConditions: msg,
      };
      b.addNode(node);
      errorNodes++;
    }

    // ── Action ↔ technical-layer bindings (per-archetype, capped) ─────────
    // Index: actionId → flow archetype. Each Flow's INCLUDES_ACTION edges
    // tell us which flow an action belongs to; flow.archetype is what we
    // need to pick the right contract.
    const actionToArchetype = new Map<string, string | undefined>();
    for (const f of b.byKind('flow')) {
      for (const e of b.outgoing(f.id, 'INCLUDES_ACTION')) {
        if (!actionToArchetype.has(e.to)) actionToArchetype.set(e.to, f.archetype);
      }
    }
    // Index: archetype → contract list. Built off contract.role via roleToArchetype.
    const contractsByArchetype = new Map<string, ContractCallNode[]>();
    for (const co of kg.contracts ?? []) {
      const arche = roleToArchetype(co.role);
      if (!arche) continue;
      const cid = mintId('contractCall', { addr: co.address, role: co.role });
      const cc = b.nodes.get(cid);
      if (!cc || cc.kind !== 'contractCall') continue;
      const list = contractsByArchetype.get(arche) ?? [];
      list.push(cc as ContractCallNode);
      contractsByArchetype.set(arche, list);
    }
    // Token contract acts as the default for transactional actions when the
    // flow's archetype has no direct contract match (most wallet-sign actions
    // touch the collateral token first).
    const tokenContracts = contractsByArchetype.get('token') ?? [];

    let triggerEdges = 0, invokeEdges = 0;
    const apis = b.byKind('apiCall');
    const MAX_APIS_PER_ACTION = 3;
    for (const a of b.byKind('action') as ActionNode[]) {
      // API binding — keyword overlap, capped at 3 per action so we don't
      // turn the whole graph into a hairball. Prefer observed-in-network
      // ApiCalls over bundle-only ones.
      const candidates: { api: ApiCallNode; score: number }[] = [];
      for (const api of apis as ApiCallNode[]) {
        if (!keywordOverlap(a.label, api.urlPattern)) continue;
        const score = (api.provenance === 'observed' ? 10 : 0) + (api.responseSchema ? 5 : 0);
        candidates.push({ api, score });
      }
      candidates.sort((x, y) => y.score - x.score);
      for (const { api } of candidates.slice(0, MAX_APIS_PER_ACTION)) {
        const eid = mintId('edge', { from: a.id, to: api.id, t: 'TRIGGERS_API_CALL' });
        b.addEdge({
          ...stamp({ id: eid, crawlId, provenance: 'inferred', observedAt, inferenceSource: 'tech-binder:keyword-overlap' }),
          from: a.id, to: api.id, edgeType: 'TRIGGERS_API_CALL',
        });
        triggerEdges++;
      }

      // Contract binding — wallet-sign only, restricted to flow's archetype.
      if (a.actionType !== 'wallet-sign') continue;
      const arche = actionToArchetype.get(a.id);
      const target = (arche && contractsByArchetype.get(arche)?.[0]) ?? tokenContracts[0];
      if (!target) continue;
      const eid = mintId('edge', { from: a.id, to: target.id, t: 'INVOKES_CONTRACT_CALL' });
      b.addEdge({
        ...stamp({ id: eid, crawlId, provenance: 'inferred', observedAt, inferenceSource: `tech-binder:archetype:${arche ?? 'token-default'}` }),
        from: a.id, to: target.id, edgeType: 'INVOKES_CONTRACT_CALL',
      });
      invokeEdges++;
    }

    // ── Drop unbound bundle-only nodes (bloat reduction) ──────────────────
    // These accumulate from third-party SDK bundles (WalletConnect auth/mfa,
    // farcaster, recovery flows) that have nothing to do with the dApp's
    // actual user flows. If nothing in the behavioral layer points to them,
    // they're noise — drop them with their incident edges.
    let droppedApi = 0, droppedErr = 0;
    for (const api of [...b.byKind('apiCall')] as ApiCallNode[]) {
      if (api.provenance === 'observed') continue;       // observed in network → keep
      if (api.inferenceSource !== 'tech-binder:bundle-analysis' && api.inferenceSource !== 'kg-migrate:from-apiEndpoint') continue;
      if (b.incoming(api.id, 'TRIGGERS_API_CALL').length > 0) continue;
      b.removeNode(api.id);
      droppedApi++;
    }
    for (const er of [...b.byKind('errorResponse')] as ErrorResponseNode[]) {
      if (er.inferenceSource !== 'tech-binder:bundle-errorMessages') continue;
      if (b.incoming(er.id, 'RETURNS_ERROR').length > 0) continue;
      b.removeNode(er.id);
      droppedErr++;
    }

    saveKGv2(b, outDir);
    console.log(`[tech-binder] api: ${apiEnriched} obs + ${apiFromBundle} bundle (dropped ${droppedApi} unbound) | contracts: ${contractEnriched} enriched, ${eventsEmitted} events | errors: ${errorNodes} → ${errorNodes - droppedErr} bound | edges: ${triggerEdges} TRIGGERS_API_CALL, ${invokeEdges} INVOKES_CONTRACT_CALL`);
    return {};
  };
}

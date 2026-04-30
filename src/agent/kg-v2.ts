/**
 * KG v2 — four-layer knowledge graph.
 *
 * Layers kept separate at the schema level:
 *   1. Structural   — Page / Section / Component / Element + CONTAINS
 *   2. Behavioral   — State / Action + REQUIRES_STATE / TRANSITIONS_TO / FAILS_TO / PERFORMED_VIA
 *   3. Technical    — ApiCall / ContractCall / Event / ErrorResponse + TRIGGERS_API_CALL / INVOKES_CONTRACT_CALL / EMITS_EVENT / RETURNS_ERROR
 *   4. Semantic     — Flow + START_STATE / END_STATE / INCLUDES_ACTION / DESCRIBED_BY
 *
 * Cross-cutting on every node + edge:
 *   - hash-based id (deterministic on stable props)
 *   - validFrom / validTo (versioning)
 *   - observedIn[] crawl ids (provenance)
 *   - walletContext[] tags (which wallet states produced this observation)
 *   - provenance: 'observed' | 'inferred' + inferenceSource
 *
 * Storage: JSON file at <outputDir>/kg-v2/v<N>/{nodes,edges,meta}.json plus
 * latest-symlink kg-v2.json. Per-crawl snapshot = versioning. Diff with jq.
 */
import { createHash } from 'crypto';

// ── Cross-cutting fields ─────────────────────────────────────────────────

export type WalletContext =
  | 'disconnected'
  | 'connected-empty'
  | 'connected-with-funds'
  | 'connected-with-position'
  | 'wrong-network';

export type Provenance = 'observed' | 'inferred';

export interface CrossCuttingFields {
  /** Deterministic id derived from (kind, layer, stableProps). 12-hex sha1. */
  id: string;
  /** ISO timestamp this node/edge first observed. */
  validFrom: string;
  /** ISO timestamp this node/edge last observed. null = still valid. */
  validTo: string | null;
  /** Crawl ids that produced this. Multiple = observed across crawls. */
  observedIn: string[];
  /** Which wallet contexts produced observations of this node. */
  walletContext?: WalletContext[];
  /** observed = directly seen by crawler; inferred = derived by pipeline / LLM. */
  provenance: Provenance;
  /** When inferred, name of the pipeline phase / model that produced it. */
  inferenceSource?: string;
}

// ── Layer 1 — Structural ─────────────────────────────────────────────────

export type StructuralKind = 'page' | 'section' | 'component' | 'element';

/** Controlled vocabulary for component_type. Stays small on purpose. */
export type ComponentType =
  | 'form'
  | 'modal-trigger'
  | 'transaction-button'
  | 'table'
  | 'input'
  | 'display'
  | 'nav-link'
  | 'select'
  | 'toggle'
  | 'tab'
  | 'other';

export interface StructuralNode extends CrossCuttingFields {
  layer: 'structural';
  kind: StructuralKind;
  label: string;
  /** Page only. Route pattern, not full URL — '/trade' not 'https://...'. */
  routePattern?: string;
  /** Component / element only. Playwright-compatible. */
  selector?: string;
  /** Component only. */
  componentType?: ComponentType;
  /** Component / element only. */
  testId?: string;
  /** Component / element only. data-* attributes etc. for stable identity. */
  stableAttrs?: Record<string, string>;
  /** Cross-link to legacy v1 component id, for adapter back-compat. */
  legacyV1Id?: string;
}

// ── Layer 2 — Behavioral ─────────────────────────────────────────────────

export type WalletStatus = 'disconnected' | 'connected' | 'wrong-network';
export type PositionStatus = 'none' | 'pending' | 'open' | 'closing' | 'closed' | 'liquidatable';

export interface StateConditions {
  walletStatus?: WalletStatus;
  network?: string;          // chain name or chainId
  balanceRange?: { min?: number; max?: number; token?: string };
  positionStatus?: PositionStatus;
  /** UI-level signals that distinguish this state (button text, banner, modal title). */
  visibleIndicators?: string[];
  /** Free-form description of any other distinguishing condition. */
  notes?: string;
}

export interface StateNode extends CrossCuttingFields {
  layer: 'behavioral';
  kind: 'state';
  label: string;
  conditions: StateConditions;
  /** Marks states that represent failure / error conditions. Validator counts these. */
  isError?: boolean;
  /** Initial state of the dApp (e.g. WalletDisconnected). Validator allows
   *  these to have no incoming transitions. */
  isInitial?: boolean;
}

export type ActionType = 'click' | 'input' | 'wallet-sign' | 'navigate' | 'wait' | 'select';

export interface ActionNode extends CrossCuttingFields {
  layer: 'behavioral';
  kind: 'action';
  label: string;
  actionType: ActionType;
  /** For 'input' / 'select' actions: the value supplied. */
  inputValue?: string;
}

// ── Layer 3 — Technical ──────────────────────────────────────────────────

export interface ApiCallNode extends CrossCuttingFields {
  layer: 'technical';
  kind: 'apiCall';
  method: string;            // GET, POST, etc.
  urlPattern: string;        // path with {placeholders}, not full URL
  /** JSONSchema-like (kept loose — Record<string, unknown>) so we don't pull in zod here. */
  requestSchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  expectedStatusCodes?: number[];
  /** true = fire-and-poll / streaming; false = synchronous request/response. */
  isAsync?: boolean;
  expectedLatencyMs?: { min?: number; max?: number };
}

export interface ContractCallNode extends CrossCuttingFields {
  layer: 'technical';
  kind: 'contractCall';
  contractAddress: string;       // 0x... lowercase
  chainId?: number;
  /** Solidity-style: 'transfer(address,uint256)'. */
  functionSignature: string;
  /** Event node ids the call is expected to emit on success. */
  expectedEventIds: string[];
  gasEstimate?: { min?: number; max?: number };
  /** Free-form (e.g. 'view', 'payable', 'nonpayable'). */
  stateMutability?: string;
}

export interface EventNode extends CrossCuttingFields {
  layer: 'technical';
  kind: 'event';
  contractAddress: string;
  /** Solidity-style: 'Transfer(address,address,uint256)'. */
  signature: string;
  /** Topic hash if known. */
  topicHash?: string;
  /** Decoded params (name + solidity type + indexed flag). */
  params: { name: string; type: string; indexed: boolean }[];
}

export interface ErrorResponseNode extends CrossCuttingFields {
  layer: 'technical';
  kind: 'errorResponse';
  origin: 'api' | 'contract' | 'wallet';
  /** HTTP status for api, revert string / custom-error for contract, popup label for wallet. */
  code?: string;
  /** Body shape (api) or arg shape (contract custom error). */
  shape?: Record<string, unknown>;
  /** Conditions that cause this error to fire. */
  triggerConditions: string;
}

// ── Layer 4 — Semantic ───────────────────────────────────────────────────

export interface FlowNode extends CrossCuttingFields {
  layer: 'semantic';
  kind: 'flow';
  label: string;
  description: string;
  /** Bounding behavioral states. Resolved at traversal time. */
  startStateId: string;
  endStateId: string;
  /** Actions central to the flow, in order. */
  actionIds: string[];
  /** Optional doc section ids that describe this flow. */
  docSectionIds?: string[];
  /** Inherited archetype (perps, swap, lending, etc.) for spec-gen. */
  archetype?: string;
  /** Cross-link to legacy v1 capability id. */
  legacyCapabilityId?: string;
}

/** Documentation chunk — a section of the dApp's docs the agent can cite
 *  when explaining WHY a flow exists or what rules govern it. */
export interface DocSectionNode extends CrossCuttingFields {
  layer: 'semantic';
  kind: 'docSection';
  title: string;
  /** Trimmed text content (capped to keep KG file size bounded). */
  content: string;
  /** LLM-extracted topic labels ('zero-fee perpetuals', 'collateral'). */
  topics: string[];
  /** LLM-extracted rule statements ('Min leverage for ZFP is 75x'). */
  rules: string[];
  /** Source URL if known. */
  url?: string;
}

/** A protocol constraint pulled from docs / observations — max leverage,
 *  min collateral, allowed order types per asset class, etc. The agent uses
 *  these to derive boundary tests and to know when an action SHOULD reject. */
export interface ConstraintNode extends CrossCuttingFields {
  layer: 'semantic';
  kind: 'constraint';
  label: string;                 // 'Max leverage'
  value: string;                 // '250'
  bounds?: { min?: number; max?: number; unit?: string };
  scope?: string;                // 'Zero Fee Perps' / 'Forex pairs' / 'all'
  /** What this constraint implies for tests — copied from v1 KGConstraint. */
  testImplication?: string;
  /** Where it came from. */
  source?: 'docs' | 'observed' | 'comprehension';
}

/** A tradable asset (or token, vault, etc.) — symbol + class + per-asset
 *  metadata the agent uses to answer "what assets exist" / "max leverage on
 *  WTI". */
export interface AssetNode extends CrossCuttingFields {
  layer: 'semantic';
  kind: 'asset';
  symbol: string;                // 'BTC-USD'
  group: string;                 // 'CRYPTO1' / 'FOREX' / 'COMMODITY'
  /** Coarse class (crypto / fx / equity / commodity / metal) — useful for
   *  cross-dApp queries. */
  assetClass?: string;
  maxLeverage?: number;
  minCollateral?: number;
  tradingHours?: string;
}

/** A first-class dApp feature — 'Zero Fee Perpetuals', 'Guaranteed TP/SL'.
 *  Mostly for documentation surface — the agent can answer "does this dApp
 *  support X?" by checking whether feature node exists. */
export interface FeatureNode extends CrossCuttingFields {
  layer: 'semantic';
  kind: 'feature';
  name: string;
  description: string;
  /** Optional human-readable constraints ('min 75x leverage, crypto only'). */
  constraints?: string;
}

// ── Union + edges ────────────────────────────────────────────────────────

export type KGv2Node =
  | StructuralNode
  | StateNode
  | ActionNode
  | ApiCallNode
  | ContractCallNode
  | EventNode
  | ErrorResponseNode
  | FlowNode
  | DocSectionNode
  | ConstraintNode
  | AssetNode
  | FeatureNode;

export type EdgeType =
  // structural
  | 'CONTAINS'
  // behavioral
  | 'REQUIRES_STATE'
  | 'TRANSITIONS_TO'
  | 'FAILS_TO'
  | 'PERFORMED_VIA'
  // technical
  | 'TRIGGERS_API_CALL'
  | 'INVOKES_CONTRACT_CALL'
  | 'EMITS_EVENT'
  | 'RETURNS_ERROR'
  // semantic
  | 'START_STATE'
  | 'END_STATE'
  | 'INCLUDES_ACTION'
  | 'DESCRIBED_BY'
  | 'CONSTRAINS'         // constraint → action / state — preconditions for boundary tests
  | 'OPERATES_ON'        // flow → asset — which asset(s) a flow can target
  | 'EXPOSES_FEATURE';   // page → feature — which page surfaces which feature

export interface KGv2Edge extends CrossCuttingFields {
  from: string;
  to: string;
  edgeType: EdgeType;
  label?: string;
}

export interface KGv2 {
  schemaVersion: 2;
  dappUrl: string;
  crawlId: string;
  generatedAt: string;
  nodes: KGv2Node[];
  edges: KGv2Edge[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Stable canonical JSON — sorts object keys recursively so id derivation
 *  doesn't depend on key insertion order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/** Mint a deterministic id from kind + stable props. 12-hex sha1 prefix.
 *  Format: '<kind>:<12hex>' so ids are scannable. */
export function mintId(kind: string, stableProps: unknown): string {
  const h = createHash('sha1').update(canonicalJson(stableProps)).digest('hex').slice(0, 12);
  return `${kind}:${h}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Build a CrossCuttingFields stamp. Caller supplies provenance. */
export function stamp(opts: {
  id: string;
  crawlId: string;
  provenance: Provenance;
  inferenceSource?: string;
  walletContext?: WalletContext[];
  observedAt?: string;
}): CrossCuttingFields {
  const ts = opts.observedAt ?? nowIso();
  return {
    id: opts.id,
    validFrom: ts,
    validTo: null,
    observedIn: [opts.crawlId],
    provenance: opts.provenance,
    ...(opts.inferenceSource ? { inferenceSource: opts.inferenceSource } : {}),
    ...(opts.walletContext ? { walletContext: opts.walletContext } : {}),
  };
}

// ── Builder + merge ──────────────────────────────────────────────────────

/** In-memory KGv2 with O(1) lookups + dedup-on-merge. */
export class KGv2Builder {
  readonly nodes = new Map<string, KGv2Node>();
  readonly edges = new Map<string, KGv2Edge>();
  readonly outAdj = new Map<string, KGv2Edge[]>();
  readonly inAdj = new Map<string, KGv2Edge[]>();

  constructor(public readonly dappUrl: string, public readonly crawlId: string) {}

  addNode(n: KGv2Node): KGv2Node {
    const existing = this.nodes.get(n.id);
    if (existing) return this.mergeNode(existing, n);
    this.nodes.set(n.id, n);
    if (!this.outAdj.has(n.id)) this.outAdj.set(n.id, []);
    if (!this.inAdj.has(n.id)) this.inAdj.set(n.id, []);
    return n;
  }

  addEdge(e: KGv2Edge): KGv2Edge {
    const existing = this.edges.get(e.id);
    if (existing) return this.mergeEdge(existing, e);
    this.edges.set(e.id, e);
    (this.outAdj.get(e.from) ?? this.outAdj.set(e.from, []).get(e.from)!).push(e);
    (this.inAdj.get(e.to) ?? this.inAdj.set(e.to, []).get(e.to)!).push(e);
    return e;
  }

  /** Merge: union observedIn + walletContext, keep earliest validFrom, latest validTo. */
  private mergeNode(a: KGv2Node, b: KGv2Node): KGv2Node {
    a.observedIn = [...new Set([...a.observedIn, ...b.observedIn])];
    if (b.walletContext) {
      a.walletContext = [...new Set([...(a.walletContext ?? []), ...b.walletContext])];
    }
    if (b.validFrom < a.validFrom) a.validFrom = b.validFrom;
    a.validTo = null;  // re-observation re-opens
    if (a.provenance === 'inferred' && b.provenance === 'observed') {
      a.provenance = 'observed';
      delete (a as any).inferenceSource;
    }
    return a;
  }
  private mergeEdge(a: KGv2Edge, b: KGv2Edge): KGv2Edge {
    a.observedIn = [...new Set([...a.observedIn, ...b.observedIn])];
    if (b.validFrom < a.validFrom) a.validFrom = b.validFrom;
    a.validTo = null;
    return a;
  }

  outgoing(nodeId: string, type?: EdgeType): KGv2Edge[] {
    const all = this.outAdj.get(nodeId) ?? [];
    return type ? all.filter(e => e.edgeType === type) : all;
  }
  incoming(nodeId: string, type?: EdgeType): KGv2Edge[] {
    const all = this.inAdj.get(nodeId) ?? [];
    return type ? all.filter(e => e.edgeType === type) : all;
  }

  byKind<T extends KGv2Node['kind']>(kind: T): Extract<KGv2Node, { kind: T }>[] {
    const out: KGv2Node[] = [];
    for (const n of this.nodes.values()) if (n.kind === kind) out.push(n);
    return out as Extract<KGv2Node, { kind: T }>[];
  }

  /** Remove a node and ALL incident edges. Returns count removed. */
  removeNode(id: string): { node: number; edges: number } {
    if (!this.nodes.has(id)) return { node: 0, edges: 0 };
    let edgeCount = 0;
    for (const e of [...(this.outAdj.get(id) ?? [])]) { this.removeEdge(e.id); edgeCount++; }
    for (const e of [...(this.inAdj.get(id) ?? [])]) { this.removeEdge(e.id); edgeCount++; }
    this.nodes.delete(id);
    this.outAdj.delete(id);
    this.inAdj.delete(id);
    return { node: 1, edges: edgeCount };
  }

  removeEdge(edgeId: string): boolean {
    const e = this.edges.get(edgeId);
    if (!e) return false;
    this.edges.delete(edgeId);
    const o = this.outAdj.get(e.from);
    if (o) this.outAdj.set(e.from, o.filter(x => x.id !== edgeId));
    const i = this.inAdj.get(e.to);
    if (i) this.inAdj.set(e.to, i.filter(x => x.id !== edgeId));
    return true;
  }

  serialize(): KGv2 {
    return {
      schemaVersion: 2,
      dappUrl: this.dappUrl,
      crawlId: this.crawlId,
      generatedAt: nowIso(),
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
  }

  static load(kg: KGv2): KGv2Builder {
    const b = new KGv2Builder(kg.dappUrl, kg.crawlId);
    for (const n of kg.nodes) b.addNode(n);
    for (const e of kg.edges) b.addEdge(e);
    return b;
  }
}

// ── Snapshot diff ────────────────────────────────────────────────────────

export interface KGv2Diff {
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: string[];   // same id, different stable props
  addedEdges: string[];
  removedEdges: string[];
}

export function diffKG(prev: KGv2, next: KGv2): KGv2Diff {
  const prevNodes = new Map(prev.nodes.map(n => [n.id, n]));
  const nextNodes = new Map(next.nodes.map(n => [n.id, n]));
  const prevEdges = new Set(prev.edges.map(e => e.id));
  const nextEdges = new Set(next.edges.map(e => e.id));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, n] of nextNodes) {
    if (!prevNodes.has(id)) added.push(id);
    else {
      const a = prevNodes.get(id)!;
      // Compare stable subset (label + kind + selector for structural, conditions for state, etc.)
      if (canonicalJson(stripVolatile(a)) !== canonicalJson(stripVolatile(n))) changed.push(id);
    }
  }
  for (const id of prevNodes.keys()) if (!nextNodes.has(id)) removed.push(id);
  return {
    addedNodes: added,
    removedNodes: removed,
    changedNodes: changed,
    addedEdges: [...nextEdges].filter(id => !prevEdges.has(id)),
    removedEdges: [...prevEdges].filter(id => !nextEdges.has(id)),
  };
}

function stripVolatile(n: KGv2Node): Record<string, unknown> {
  const { validFrom: _vf, validTo: _vt, observedIn: _o, walletContext: _w, provenance: _p, inferenceSource: _is, ...rest } = n as any;
  return rest;
}

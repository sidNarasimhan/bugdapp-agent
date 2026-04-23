import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';

// ── Knowledge Graph Node Types ──

export interface KGPage {
  id: string;
  url: string;
  name: string;
  title: string;
  elementCount: number;
  walletRequired: boolean;
}

export interface KGComponent {
  id: string;
  pageId: string;
  role: string;         // button, input, switch, tab, combobox, slider
  name: string;
  selector: string;     // Playwright selector (getByRole, getByText, etc.)
  testId?: string;
  disabled: boolean;
  dynamic: boolean;     // true if content changes (prices, balances)
}

export interface KGAction {
  id: string;
  componentId: string;
  type: 'click' | 'type' | 'toggle' | 'select' | 'drag' | 'scroll';
  value?: string;       // for type/select actions
  resultDescription: string;
  newElementsAppeared: string[];
  elementsDisappeared: string[];
  triggersWallet: boolean;
  success: boolean;
}

export interface KGFlow {
  id: string;
  name: string;         // e.g. "Place BTC-USD Long Market Order"
  description: string;
  pageId: string;
  steps: KGFlowStep[];
  requiresFundedWallet: boolean;
  category: string;     // trading, navigation, portfolio, earn, wallet, error
  priority: number;     // 1=critical, 2=important, 3=nice-to-have
  tested: boolean;
  testResult?: 'pass' | 'fail' | 'untested';
}

export interface KGFlowStep {
  order: number;
  actionId?: string;
  description: string;
  expectedOutcome: string;
  selector?: string;
}

export interface KGEdgeCase {
  id: string;
  flowId: string;
  name: string;         // e.g. "Zero collateral", "Max leverage", "Wrong network"
  description: string;
  inputValue?: string;
  expectedBehavior: string;
  tested: boolean;
  testResult?: 'pass' | 'fail' | 'untested';
}

export interface KGTestCase {
  id: string;
  flowId?: string;
  edgeCaseId?: string;
  name: string;
  specFile?: string;
  specCode?: string;
  status: 'planned' | 'generated' | 'pass' | 'fail' | 'healed';
  error?: string;
  attempts: number;
}

export interface KGEdge {
  from: string;         // source node id
  to: string;           // target node id
  relationship: string; // 'contains' | 'triggers' | 'requires' | 'navigatesTo' | 'tests' | 'partOf'
}

// ── Rich Context Nodes (from docs, APIs, dropdowns) ──

export interface KGFeature {
  id: string;
  name: string;         // e.g. "Zero Fee Perpetuals", "Guaranteed TP/SL"
  description: string;  // from docs
  pageId?: string;
  constraints?: string; // e.g. "min 75x leverage, crypto majors + memes only"
}

export interface KGAsset {
  id: string;
  symbol: string;       // e.g. "BTC-USD", "EUR-USD"
  group: string;        // e.g. "Crypto", "Forex", "Commodities"
  maxLeverage?: number;
  minCollateral?: number;
  tradingHours?: string;
}

export interface KGDropdownOption {
  id: string;
  componentId: string;  // which dropdown component
  value: string;        // the option text
  index: number;
}

export interface KGDocSection {
  id: string;
  title: string;
  content: string;      // trimmed text
  keywords: string[];   // extracted keywords
}

export interface KGApiEndpoint {
  id: string;
  path: string;
  description: string;  // what the response contains
  sampleKeys: string[]; // top-level keys from response
}

export interface KGConstraint {
  id: string;
  name: string;           // e.g. "Max leverage", "Liquidation threshold"
  value: string;          // e.g. "500x", "80% collateral health"
  scope?: string;         // e.g. "ZFP only", "Forex pairs", "all assets"
  testImplication: string; // e.g. "Test placing order at 501x leverage — should be rejected"
  source: string;         // where this was found: "docs", "api", "explorer"
}

export interface KGContract {
  id: string;
  address: string;        // 0x + 40 hex, lowercase
  chainId?: number;       // best-guess chain from source context, if known
  name?: string;          // if verified by etherscan
  role?: string;          // router | token | pool | oracle | factory | lending | other
  source: 'docs' | 'network' | 'bundle' | 'profile';
  verified?: boolean;     // true if Etherscan confirms source code is verified
}

export interface KnowledgeGraph {
  pages: KGPage[];
  components: KGComponent[];
  actions: KGAction[];
  flows: KGFlow[];
  edgeCases: KGEdgeCase[];
  testCases: KGTestCase[];
  edges: KGEdge[];
  features: KGFeature[];
  assets: KGAsset[];
  dropdownOptions: KGDropdownOption[];
  docSections: KGDocSection[];
  apiEndpoints: KGApiEndpoint[];
  constraints: KGConstraint[];
  contracts: KGContract[];
}

export function emptyKnowledgeGraph(): KnowledgeGraph {
  return {
    pages: [], components: [], actions: [], flows: [], edgeCases: [],
    testCases: [], edges: [], features: [], assets: [], dropdownOptions: [],
    docSections: [], apiEndpoints: [], constraints: [], contracts: [],
  };
}

function mergeKG(existing: KnowledgeGraph, update: KnowledgeGraph): KnowledgeGraph {
  const mergeById = <T extends { id: string }>(a: T[], b: T[]): T[] => {
    const map = new Map(a.map(x => [x.id, x]));
    for (const item of b) map.set(item.id, item);
    return [...map.values()];
  };
  return {
    pages: mergeById(existing.pages, update.pages),
    components: mergeById(existing.components, update.components),
    actions: mergeById(existing.actions, update.actions),
    flows: mergeById(existing.flows, update.flows),
    edgeCases: mergeById(existing.edgeCases, update.edgeCases),
    testCases: mergeById(existing.testCases, update.testCases),
    features: mergeById(existing.features, update.features),
    assets: mergeById(existing.assets, update.assets),
    dropdownOptions: mergeById(existing.dropdownOptions, update.dropdownOptions),
    docSections: mergeById(existing.docSections, update.docSections),
    apiEndpoints: mergeById(existing.apiEndpoints, update.apiEndpoints),
    constraints: mergeById(existing.constraints, update.constraints),
    contracts: mergeById(existing.contracts ?? [], update.contracts ?? []),
    edges: [...existing.edges, ...update.edges.filter(e =>
      !existing.edges.some(x => x.from === e.from && x.to === e.to && x.relationship === e.relationship)
    )],
  };
}

// ── Real Graph (built by KG_Builder from flat arrays) ──

export type GraphNodeType = 'page' | 'component' | 'form' | 'modal' | 'flow' | 'constraint' | 'edgeCase' | 'feature' | 'asset';
export type GraphEdgeType = 'REVEALS' | 'CONTAINS' | 'LEADS_TO' | 'CONFIGURES' | 'SUBMITS' | 'CONSTRAINS' | 'HAS_EDGE_CASE' | 'NAVIGATES_TO' | 'HAS_OPTION';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;         // human-readable name
  pageId?: string;       // which page this belongs to
  selector?: string;     // Playwright selector if it's a component
  role?: string;         // UI role if component
  data?: Record<string, any>; // extra data (constraint value, flow steps, etc.)
}

export interface GraphEdge {
  from: string;
  to: string;
  type: GraphEdgeType;
  label?: string;        // human-readable description
}

export interface ComputedFlow {
  id: string;
  name: string;
  path: GraphNode[];     // ordered nodes in the flow
  edges: GraphEdge[];    // edges connecting them
  selectors: string[];   // Playwright selectors for each step
  requiresFundedWallet: boolean;
  constraints: KGConstraint[];  // constraints that apply to this flow
  permutations?: { field: string; options: string[] }[]; // dropdown/toggle variations
}

/**
 * Real graph with adjacency list and traversal methods.
 * Built by KG_Builder from crawler + explorer data.
 */
export class DAppGraph {
  nodes = new Map<string, GraphNode>();
  outEdges = new Map<string, GraphEdge[]>();  // adjacency list (outgoing)
  inEdges = new Map<string, GraphEdge[]>();   // reverse adjacency (incoming)

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.outEdges.has(node.id)) this.outEdges.set(node.id, []);
    if (!this.inEdges.has(node.id)) this.inEdges.set(node.id, []);
  }

  addEdge(edge: GraphEdge): void {
    // Ensure nodes exist
    if (!this.outEdges.has(edge.from)) this.outEdges.set(edge.from, []);
    if (!this.inEdges.has(edge.to)) this.inEdges.set(edge.to, []);
    // Deduplicate
    const existing = this.outEdges.get(edge.from)!;
    if (!existing.some(e => e.to === edge.to && e.type === edge.type)) {
      existing.push(edge);
      this.inEdges.get(edge.to)!.push(edge);
    }
  }

  /** Get all nodes reachable from a starting node via REVEALS/LEADS_TO/CONTAINS edges */
  traverseFrom(startId: string, edgeTypes?: GraphEdgeType[]): GraphNode[] {
    const visited = new Set<string>();
    const result: GraphNode[] = [];
    const queue = [startId];
    const allowedTypes = edgeTypes ? new Set(edgeTypes) : null;

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = this.nodes.get(id);
      if (node) result.push(node);
      for (const edge of this.outEdges.get(id) || []) {
        if (allowedTypes && !allowedTypes.has(edge.type)) continue;
        if (!visited.has(edge.to)) queue.push(edge.to);
      }
    }
    return result;
  }

  /** Find all multi-screen flows: paths that go through REVEALS edges */
  getRevealFlows(): ComputedFlow[] {
    const flows: ComputedFlow[] = [];
    // Start from components that have REVEALS edges
    const revealStarts = new Set<string>();
    for (const [nodeId, edges] of this.outEdges) {
      if (edges.some(e => e.type === 'REVEALS')) revealStarts.add(nodeId);
    }

    for (const startId of revealStarts) {
      // Only start from nodes that have no incoming REVEALS (they're flow entry points)
      const incoming = this.inEdges.get(startId) || [];
      if (incoming.some(e => e.type === 'REVEALS')) continue;

      const path = this.followChain(startId, ['REVEALS', 'LEADS_TO']);
      if (path.length >= 2) {
        flows.push({
          id: `flow:reveal:${startId}`,
          name: path.map(n => n.label).join(' → '),
          path,
          edges: this.getEdgesBetween(path),
          selectors: path.filter(n => n.selector).map(n => n.selector!),
          requiresFundedWallet: path.some(n => n.data?.triggersWallet),
          constraints: [],
        });
      }
    }
    return flows;
  }

  /** Get all form flows: components that CONFIGURE a form + SUBMITS edge */
  getFormFlows(): ComputedFlow[] {
    const flows: ComputedFlow[] = [];
    const formNodes = [...this.nodes.values()].filter(n => n.type === 'form');

    for (const form of formNodes) {
      const configEdges = (this.inEdges.get(form.id) || []).filter(e => e.type === 'CONFIGURES');
      const submitEdges = (this.inEdges.get(form.id) || []).filter(e => e.type === 'SUBMITS');
      if (configEdges.length === 0 || submitEdges.length === 0) continue;

      const configNodes = configEdges.map(e => this.nodes.get(e.from)!).filter(Boolean);
      const submitNode = submitEdges.map(e => this.nodes.get(e.from)!).filter(Boolean)[0];
      if (!submitNode) continue;

      // Sort: selectors first, then inputs, then toggles, then submit
      const roleOrder: Record<string, number> = { combobox: 0, option: 0, spinbutton: 1, textbox: 1, slider: 1, switch: 2 };
      configNodes.sort((a, b) => (roleOrder[a.role || ''] ?? 1) - (roleOrder[b.role || ''] ?? 1));

      const path = [...configNodes, submitNode];

      // Find permutations from dropdowns and toggles
      const permutations: { field: string; options: string[] }[] = [];
      for (const node of configNodes) {
        // Dropdowns/comboboxes and buttons with HAS_OPTION edges
        const optionEdges = (this.outEdges.get(node.id) || []).filter(e => e.type === 'HAS_OPTION');
        if (optionEdges.length > 0) {
          const opts = optionEdges.map(e => this.nodes.get(e.to)?.label || '').filter(Boolean);
          if (opts.length > 0) {
            permutations.push({ field: node.label, options: opts });
          }
        } else if (node.role === 'switch') {
          permutations.push({ field: node.label, options: ['on', 'off'] });
        }
      }

      // Find constraints that apply to any component in this form
      const constraintEdges = configNodes.flatMap(n =>
        (this.inEdges.get(n.id) || []).filter(e => e.type === 'CONSTRAINS')
      );
      const constraints = constraintEdges
        .map(e => this.nodes.get(e.from))
        .filter(Boolean)
        .map(n => n!.data as KGConstraint)
        .filter(Boolean);

      flows.push({
        id: `flow:form:${form.id}`,
        name: `${form.label}: ${configNodes.map(n => n.label).join(' + ')} → ${submitNode.label}`,
        path,
        edges: this.getEdgesBetween(path),
        selectors: path.filter(n => n.selector).map(n => n.selector!),
        requiresFundedWallet: submitNode.data?.triggersWallet || false,
        constraints,
        permutations,
      });
    }
    return flows;
  }

  /** Get all flows: reveal flows + form flows + explorer-reported flows */
  getAllFlows(): ComputedFlow[] {
    return [...this.getRevealFlows(), ...this.getFormFlows()];
  }

  /** Get components that have no outgoing edges (unexplored) */
  getUnconnectedComponents(): GraphNode[] {
    return [...this.nodes.values()].filter(n =>
      n.type === 'component' &&
      (this.outEdges.get(n.id) || []).length === 0 &&
      (this.inEdges.get(n.id) || []).filter(e => e.type !== 'CONTAINS').length === 0
    );
  }

  /** Get flows that haven't been tested */
  getUntestedFlows(): ComputedFlow[] {
    return this.getAllFlows(); // all flows from graph are untested by definition
  }

  /** Get constraints for a specific component */
  getConstraintsFor(nodeId: string): GraphNode[] {
    return (this.inEdges.get(nodeId) || [])
      .filter(e => e.type === 'CONSTRAINS')
      .map(e => this.nodes.get(e.from)!)
      .filter(Boolean);
  }

  /** Follow a chain of edges from a node */
  private followChain(startId: string, edgeTypes: GraphEdgeType[]): GraphNode[] {
    const chain: GraphNode[] = [];
    const visited = new Set<string>();
    let current = startId;

    while (current && !visited.has(current)) {
      visited.add(current);
      const node = this.nodes.get(current);
      if (node) chain.push(node);

      const nextEdge = (this.outEdges.get(current) || [])
        .find(e => edgeTypes.includes(e.type) && !visited.has(e.to));
      current = nextEdge?.to || '';
    }
    return chain;
  }

  /** Get edges between consecutive nodes in a path */
  private getEdgesBetween(path: GraphNode[]): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const edge = (this.outEdges.get(path[i].id) || [])
        .find(e => e.to === path[i + 1].id);
      if (edge) edges.push(edge);
    }
    return edges;
  }

  /** Stats for logging */
  get stats() {
    const edgeCount = [...this.outEdges.values()].reduce((s, e) => s + e.length, 0);
    return { nodes: this.nodes.size, edges: edgeCount };
  }

  /** Serialize for persistence / state */
  serialize(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const edges: GraphEdge[] = [];
    for (const arr of this.outEdges.values()) edges.push(...arr);
    return { nodes: [...this.nodes.values()], edges };
  }

  /** Deserialize from persistence */
  static deserialize(data: { nodes: GraphNode[]; edges: GraphEdge[] }): DAppGraph {
    const g = new DAppGraph();
    for (const n of data.nodes) g.addNode(n);
    for (const e of data.edges) g.addEdge(e);
    return g;
  }
}

// ── Test Plan ──

export interface TestPlan {
  suites: {
    name: string;
    description: string;
    tests: {
      id: string;
      name: string;
      flowId?: string;
      steps: string[];
      expectedOutcome: string;
      requiresFundedWallet: boolean;
      priority: number;
    }[];
  }[];
}

// ── Test Result ──

export interface TestResult {
  testId: string;
  title: string;
  specFile: string;
  status: 'passed' | 'failed' | 'skipped';
  error?: string;
  durationMs: number;
}

// ── LangGraph State ──

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // Knowledge graph — shared across all agents
  knowledgeGraph: Annotation<KnowledgeGraph>({
    reducer: mergeKG,
    default: emptyKnowledgeGraph,
  }),

  // Real graph (built by KG_Builder, used by explorer/planner)
  graph: Annotation<{ nodes: GraphNode[]; edges: GraphEdge[] }>({
    reducer: (existing, update) => {
      // Merge: deserialize both, combine, re-serialize
      const g = DAppGraph.deserialize(existing);
      for (const n of update.nodes) g.addNode(n);
      for (const e of update.edges) g.addEdge(e);
      return g.serialize();
    },
    default: () => ({ nodes: [], edges: [] }),
  }),

  // Raw crawl data (from crawler, consumed by explorer/planner)
  crawlData: Annotation<any>({
    reducer: (_, update) => update,
    default: () => null,
  }),

  // Structured test plan (from planner, consumed by generator)
  testPlan: Annotation<TestPlan | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),

  // Generated spec file paths
  specFiles: Annotation<string[]>({
    reducer: (existing, update) => [...new Set([...existing, ...update])],
    default: () => [],
  }),

  // Test results (from executor)
  testResults: Annotation<TestResult[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  // Pipeline control
  iteration: Annotation<number>({
    reducer: (_, update) => update,
    default: () => 0,
  }),

  maxIterations: Annotation<number>({
    reducer: (_, update) => update,
    default: () => 3,
  }),

  // Config passed through state
  config: Annotation<{
    url: string;
    seedPhrase: string;
    apiKey: string;
    outputDir: string;
    headless: boolean;
    explorerModel: string;
    plannerModel: string;
    generatorModel: string;
    healerModel: string;
  }>({
    reducer: (_, update) => update,
    default: () => ({
      url: '',
      seedPhrase: '',
      apiKey: '',
      outputDir: '',
      headless: false,
      explorerModel: 'deepseek/deepseek-v3.2',
      plannerModel: 'deepseek/deepseek-v3.2',
      generatorModel: 'qwen/qwen3-coder',
      healerModel: 'qwen/qwen3-coder',
    }),
  }),
});

export type AgentStateType = typeof AgentState.State;

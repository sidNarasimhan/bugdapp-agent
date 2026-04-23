import { createHash } from 'crypto';
import type { StateNode, StateEdge, SerializedGraph } from '../types.js';

export class StateGraph {
  private nodes = new Map<string, StateNode>();
  private edges: StateEdge[] = [];
  private edgeCounter = 0;
  private rootHash: string | null = null;

  // ── State Hashing ──

  /** Strip volatile data (prices, percentages, balances) from a string for stable hashing */
  private static stripVolatile(s: string): string {
    return s
      // Strip prices like $70,853.1 or 51.6M or 0.31%
      .replace(/\$[\d,.]+/g, '')
      .replace(/[\d,.]+[MKBmkb]?%?/g, '')
      // Strip whitespace runs
      .replace(/\s+/g, ' ')
      .trim();
  }

  static hashState(
    url: string,
    elements: { ref: string; role: string; name: string }[],
    walletConnected: boolean,
    activeModal: string | null,
    formState: Record<string, string>,
  ): string {
    // Normalize URL: strip protocol, trailing slash, and volatile query params
    const normalizedUrl = url.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // Sort elements by role + stripped name for deterministic hashing
    // Ignore ref (changes between snapshots) and strip volatile content (prices, balances)
    const elementKeys = elements
      .map(e => `${e.role}:${StateGraph.stripVolatile(e.name)}`)
      .filter(k => k.length > 2) // drop empty-name elements
      .sort()
      .join('|');

    // Sort form state keys (ignore values — they're user input, not page state identity)
    const formKeys = Object.keys(formState).sort().join('|');

    const raw = [
      normalizedUrl,
      elementKeys,
      walletConnected ? 'wallet:yes' : 'wallet:no',
      activeModal || 'modal:none',
      formKeys,
    ].join('###');

    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  // ── Node Operations ──

  addNode(node: Omit<StateNode, 'hash' | 'visitCount'>): StateNode {
    const hash = StateGraph.hashState(
      node.url, node.elements, node.walletConnected, node.activeModal, node.formState,
    );

    const existing = this.nodes.get(hash);
    if (existing) {
      existing.visitCount++;
      // Update screenshot/snapshot if newer
      if (node.screenshotPath) existing.screenshotPath = node.screenshotPath;
      if (node.snapshotText) existing.snapshotText = node.snapshotText;
      return existing;
    }

    const stateNode: StateNode = { ...node, hash, visitCount: 1 };
    this.nodes.set(hash, stateNode);

    if (!this.rootHash) this.rootHash = hash;
    return stateNode;
  }

  getNode(hash: string): StateNode | undefined {
    return this.nodes.get(hash);
  }

  getAllNodes(): StateNode[] {
    return [...this.nodes.values()];
  }

  // ── Edge Operations ──

  addEdge(
    fromHash: string,
    toHash: string,
    action: StateEdge['action'],
    success: boolean,
    sideEffects: string[] = [],
  ): StateEdge {
    const edge: StateEdge = {
      id: `e${++this.edgeCounter}`,
      fromHash,
      toHash,
      action,
      success,
      sideEffects,
      timestamp: Date.now(),
    };
    this.edges.push(edge);
    return edge;
  }

  getEdgesFrom(hash: string): StateEdge[] {
    return this.edges.filter(e => e.fromHash === hash);
  }

  getEdgesTo(hash: string): StateEdge[] {
    return this.edges.filter(e => e.toHash === hash);
  }

  getAllEdges(): StateEdge[] {
    return [...this.edges];
  }

  // ── Path Finding ──

  /**
   * Find all paths from root to a target node using BFS.
   * Returns array of edge sequences (shortest paths first).
   */
  findPaths(targetHash: string, maxPaths = 3): StateEdge[][] {
    if (!this.rootHash || targetHash === this.rootHash) return [];

    const paths: StateEdge[][] = [];
    const queue: { nodeHash: string; path: StateEdge[] }[] = [
      { nodeHash: this.rootHash, path: [] },
    ];
    const visited = new Set<string>();

    while (queue.length > 0 && paths.length < maxPaths) {
      const { nodeHash, path } = queue.shift()!;
      if (visited.has(nodeHash)) continue;
      visited.add(nodeHash);

      for (const edge of this.getEdgesFrom(nodeHash)) {
        if (!edge.success) continue;
        const newPath = [...path, edge];

        if (edge.toHash === targetHash) {
          paths.push(newPath);
        } else if (!visited.has(edge.toHash)) {
          queue.push({ nodeHash: edge.toHash, path: newPath });
        }
      }
    }

    return paths;
  }

  /**
   * Find all unique paths from root through the graph (for test generation).
   * Each path represents a complete user flow.
   */
  findAllFlows(maxDepth = 15): StateEdge[][] {
    if (!this.rootHash) return [];

    const flows: StateEdge[][] = [];
    const dfs = (nodeHash: string, path: StateEdge[], visited: Set<string>) => {
      const outEdges = this.getEdgesFrom(nodeHash).filter(e => e.success);

      if (outEdges.length === 0 || path.length >= maxDepth) {
        if (path.length > 0) flows.push([...path]);
        return;
      }

      for (const edge of outEdges) {
        if (visited.has(edge.toHash)) {
          // Dead end (cycle) — save the path up to here
          flows.push([...path, edge]);
          continue;
        }
        visited.add(edge.toHash);
        path.push(edge);
        dfs(edge.toHash, path, visited);
        path.pop();
        visited.delete(edge.toHash);
      }
    };

    dfs(this.rootHash, [], new Set([this.rootHash]));
    return flows;
  }

  /**
   * Get nodes that have unexplored potential (few outgoing edges relative to interactive elements).
   */
  getUnderexploredNodes(minElementsPerEdge = 3): StateNode[] {
    return this.getAllNodes().filter(node => {
      const outEdges = this.getEdgesFrom(node.hash);
      const elementCount = node.elements.length;
      return elementCount > outEdges.length * minElementsPerEdge;
    });
  }

  // ── Serialization ──

  serialize(): SerializedGraph {
    return {
      nodes: this.getAllNodes(),
      edges: this.getAllEdges(),
      rootHash: this.rootHash,
    };
  }

  static deserialize(data: SerializedGraph): StateGraph {
    const graph = new StateGraph();
    for (const node of data.nodes) {
      graph.nodes.set(node.hash, node);
    }
    graph.edges = [...data.edges];
    graph.edgeCounter = data.edges.length;
    graph.rootHash = data.rootHash;
    return graph;
  }

  // ── Compact Summary (for LLM prompts) ──

  toCompactSummary(): string {
    const lines: string[] = [];
    lines.push(`State Graph: ${this.nodes.size} states, ${this.edges.length} transitions`);
    lines.push('');

    // List nodes
    lines.push('## States');
    for (const node of this.getAllNodes()) {
      const modal = node.activeModal ? ` [modal: ${node.activeModal}]` : '';
      const wallet = node.walletConnected ? ' [wallet]' : '';
      const form = Object.keys(node.formState).length > 0
        ? ` {${Object.entries(node.formState).map(([k, v]) => `${k}=${v}`).join(', ')}}`
        : '';
      lines.push(`- ${node.hash.slice(0, 8)}: ${node.pageTitle || node.url}${wallet}${modal}${form}`);
      lines.push(`  Elements: ${node.elements.map(e => `${e.role}:"${e.name}"`).join(', ')}`);
    }
    lines.push('');

    // List edges as transitions
    lines.push('## Transitions');
    for (const edge of this.edges) {
      const from = this.nodes.get(edge.fromHash);
      const to = this.nodes.get(edge.toHash);
      const fromLabel = from ? (from.pageTitle || from.url) : edge.fromHash.slice(0, 8);
      const toLabel = to ? (to.pageTitle || to.url) : edge.toHash.slice(0, 8);
      const actionStr = edge.action.target
        ? `${edge.action.type}(${edge.action.target}${edge.action.value ? ', "' + edge.action.value + '"' : ''})`
        : edge.action.type;
      const status = edge.success ? '' : ' [FAILED]';
      const effects = edge.sideEffects.length > 0 ? ` → ${edge.sideEffects.join(', ')}` : '';
      lines.push(`- ${fromLabel} --${actionStr}--> ${toLabel}${status}${effects}`);
    }
    lines.push('');

    // List user flows
    const flows = this.findAllFlows(10);
    if (flows.length > 0) {
      lines.push('## User Flows');
      for (let i = 0; i < Math.min(flows.length, 20); i++) {
        const flow = flows[i];
        const steps = flow.map(e => {
          const actionStr = e.action.target
            ? `${e.action.type}(${e.action.target})`
            : e.action.type;
          return actionStr;
        });
        const startNode = this.nodes.get(flow[0].fromHash);
        const endNode = this.nodes.get(flow[flow.length - 1].toHash);
        const startLabel = startNode?.pageTitle || startNode?.url || '?';
        const endLabel = endNode?.pageTitle || endNode?.url || '?';
        lines.push(`${i + 1}. ${startLabel} → ${endLabel}: ${steps.join(' → ')}`);
      }
    }

    return lines.join('\n');
  }

  // ── Stats ──

  get stats() {
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      successfulEdges: this.edges.filter(e => e.success).length,
      failedEdges: this.edges.filter(e => !e.success).length,
      underexplored: this.getUnderexploredNodes().length,
    };
  }
}

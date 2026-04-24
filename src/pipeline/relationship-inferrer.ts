/**
 * Relationship Inferrer — derives component-to-component edges within each
 * module (`leads_to_next`, `interacts_with`) from crawler interactions +
 * persona-flow ordering. Purely deterministic — no LLM call.
 *
 * Why no LLM: the inference has hard evidence. `leads_to_next` is derivable
 * from UserFlow.steps order. `interacts_with` is derivable from two components
 * appearing in the same step or close steps. Anything we'd ask an LLM to
 * invent here would be ungrounded.
 *
 * Output: writes edges to `output/<host>/module-edges.json`. Each edge cites
 * the UserFlow or interaction record that grounded it.
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, DAppModule, DAppUserFlow } from '../agent/state.js';

export interface ModuleEdge {
  from: string;              // componentId
  to: string;                // componentId
  moduleId: string;
  type: 'leads_to_next' | 'interacts_with';
  evidence: string;          // flow id OR interaction id
}

export function createRelationshipInferrerNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { modules, userFlows, knowledgeGraph: kg, config } = state;

    // Try to hydrate from disk if not in state
    const flows: DAppUserFlow[] = userFlows && userFlows.length > 0
      ? userFlows
      : (() => {
          const p = join(config.outputDir, 'flows-by-persona.json');
          return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : [];
        })();
    const mods: DAppModule[] = modules && modules.length > 0
      ? modules
      : (() => {
          const p = join(config.outputDir, 'modules.json');
          return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : [];
        })();

    if (mods.length === 0 || flows.length === 0) {
      console.log('[RelationshipInferrer] no modules or flows — skipping');
      return {};
    }

    console.log('━━━ Relationship Inferrer: deriving component edges ━━━');

    const validCompIds = new Set(kg.components.map(c => c.id));
    const edges: ModuleEdge[] = [];
    const seen = new Set<string>();

    // 1. leads_to_next — from ordered steps in each UserFlow
    for (const flow of flows) {
      for (let i = 0; i < flow.steps.length - 1; i++) {
        const cur = flow.steps[i].componentIds;
        const next = flow.steps[i + 1].componentIds;
        for (const from of cur) {
          for (const to of next) {
            if (!validCompIds.has(from) || !validCompIds.has(to) || from === to) continue;
            const key = `${flow.moduleId}:${from}->${to}:leads_to_next`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ from, to, moduleId: flow.moduleId, type: 'leads_to_next', evidence: flow.id });
          }
        }
      }
    }

    // 2. interacts_with — multiple components in the same step affect each other
    for (const flow of flows) {
      for (const step of flow.steps) {
        const ids = step.componentIds.filter(id => validCompIds.has(id));
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i], b = ids[j];
            const key1 = `${flow.moduleId}:${a}<->${b}:interacts_with`;
            const key2 = `${flow.moduleId}:${b}<->${a}:interacts_with`;
            if (seen.has(key1) || seen.has(key2)) continue;
            seen.add(key1);
            edges.push({ from: a, to: b, moduleId: flow.moduleId, type: 'interacts_with', evidence: flow.id });
          }
        }
      }
    }

    // 3. sanity: cycle-check on leads_to_next within each module (DAG)
    const dagViolations = detectCycles(edges.filter(e => e.type === 'leads_to_next'));
    if (dagViolations.length > 0) {
      console.warn(`[RelationshipInferrer] ${dagViolations.length} leads_to_next cycle(s) detected — dropping cycle edges`);
      const violating = new Set(dagViolations);
      // Keep edges not in the cycle
      const cleaned = edges.filter(e => !violating.has(`${e.from}->${e.to}`));
      edges.length = 0;
      edges.push(...cleaned);
    }

    const byType: Record<string, number> = {};
    const byModule: Record<string, number> = {};
    for (const e of edges) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      byModule[e.moduleId] = (byModule[e.moduleId] || 0) + 1;
    }
    console.log(`[RelationshipInferrer] ${edges.length} edges — by type:`, byType);
    console.log(`  per-module:`, byModule);

    writeFileSync(join(config.outputDir, 'module-edges.json'), JSON.stringify(edges, null, 2));
    return {};
  };
}

// Simple cycle detection: DFS, return edges participating in cycles.
function detectCycles(edges: ModuleEdge[]): string[] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const cycles: string[] = [];
  function dfs(u: string, stack: string[]): void {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        // back edge = cycle
        const cycleStart = stack.indexOf(v);
        for (let k = cycleStart; k < stack.length - 1; k++) {
          cycles.push(`${stack[k]}->${stack[k + 1]}`);
        }
        cycles.push(`${stack[stack.length - 1]}->${v}`);
      } else if (c === WHITE) {
        dfs(v, stack);
      }
    }
    color.set(u, BLACK);
    stack.pop();
  }
  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) dfs(node, []);
  }
  return cycles;
}

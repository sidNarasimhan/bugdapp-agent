/**
 * Control Wiring — infer control-to-control edges within each module:
 *   - feedsInto:   config control → submit-cta (or intermediate)
 *   - gates:       toggle/switch → other control whose range it constrains
 *   - affectedBy:  inverse of gates
 *   - revealsModuleId: button-like control that opens another module
 *   - submitsFor:  submit-cta → capability it completes (filled in later by capability-derivation)
 *
 * One LLM call per module. Constrained input: only controls within the module
 * + structured docs references. Validator drops edges pointing to unknown ids,
 * enforces acyclic feedsInto, and ensures every submit-cta has feedsInto
 * inbound from other controls.
 *
 * Cost: ~$0.02 per module × 8 ≈ $0.15.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../core/llm.js';
import type { AgentStateType, Control, StructuredDoc } from '../agent/state.js';

const MODEL = process.env.CONTROL_WIRING_MODEL ?? 'anthropic/claude-sonnet-4.5';

export function createControlWiringNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config } = state;
    const controls: Control[] = state.controls && state.controls.length > 0
      ? state.controls
      : (() => { const p = join(config.outputDir, 'controls.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    if (controls.length === 0) {
      console.log('[ControlWiring] no controls, skipping');
      return {};
    }
    const docs: StructuredDoc[] = state.structuredDocs && state.structuredDocs.length > 0
      ? state.structuredDocs
      : (() => { const p = join(config.outputDir, 'structured-docs.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();

    console.log('━━━ Control Wiring: infer feedsInto/gates/affectedBy/reveals ━━━');
    const client = createOpenRouterClient(config.apiKey || process.env.OPENROUTER_API_KEY);

    // Group controls by module
    const byModule = new Map<string, Control[]>();
    for (const c of controls) {
      if (!byModule.has(c.moduleId)) byModule.set(c.moduleId, []);
      byModule.get(c.moduleId)!.push(c);
    }

    const out: Control[] = [];
    for (const [moduleId, mControls] of byModule) {
      if (mControls.length < 2) { out.push(...mControls); continue; }
      try {
        const raw = await askWiring(client, moduleId, mControls, docs);
        const wired = applyWiring(raw, mControls);
        out.push(...wired);
        const fi = wired.reduce((n, c) => n + c.feedsInto.length, 0);
        const gt = wired.reduce((n, c) => n + c.gates.length, 0);
        console.log(`  ✔ ${moduleId} — ${fi} feedsInto, ${gt} gates`);
      } catch (e: any) {
        console.warn(`  ✗ ${moduleId}: ${e?.message ?? e}`);
        out.push(...mControls);
      }
    }

    writeFileSync(join(config.outputDir, 'controls.json'), JSON.stringify(out, null, 2));
    return { controls: out };
  };
}

const SYSTEM = [
  'You infer wiring between Controls within ONE module.',
  '',
  'Input: array of Controls (id, name, kind, options, unit).',
  '',
  'Produce edges:',
  '- feedsInto: for every config-style control (input/radio/tabs/%/slider/dropdown/modal-selector/toggle that sets form state), list the control id(s) it feeds. In a form with a submit-cta, ALL form inputs feed that submit-cta.',
  '- gates: if a toggle enables/disables another control or constrains its range (e.g. "Zero Fee Perps" toggle gates leverage range 75-250x), list which control ids it gates.',
  '- affectedBy: inverse — which controls gate THIS one. Redundant with gates but useful.',
  '- revealsModuleId: if clicking this control OPENS another module (cross-cutting context), give that module id. Usually null.',
  '',
  'Rules:',
  '- Every id in output MUST be a control id from the input. No inventing.',
  '- feedsInto graph must be a DAG (no cycles).',
  '- Every submit-cta must have ≥1 inbound feedsInto (i.e. other controls feed it).',
  '- A "modal-selector" (asset picker) feeds into the same submit-cta that other form controls feed.',
  '- Passive controls (link, tab for view switching) typically have empty feedsInto.',
  '',
  'Return STRICT JSON: array of {id, feedsInto: string[], gates: string[], affectedBy: string[], revealsModuleId?: string}. No prose.',
].join('\n');

async function askWiring(client: ReturnType<typeof createOpenRouterClient>, moduleId: string, controls: Control[], docs: StructuredDoc[]): Promise<any[]> {
  const payload = {
    moduleId,
    controls: controls.map(c => ({ id: c.id, name: c.name, kind: c.kind, options: c.options, unit: c.unit, description: c.description })),
    docRules: docs.flatMap(d => d.rules).slice(0, 20),
  };
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2500,
    temperature: 0,
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });
  const text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return []; }
}

function applyWiring(raw: any[], controls: Control[]): Control[] {
  const byId = new Map(controls.map(c => [c.id, { ...c }]));
  const validIds = new Set(byId.keys());
  const filter = (ids: any): string[] => Array.isArray(ids) ? ids.filter((x: any) => typeof x === 'string' && validIds.has(x)) : [];

  for (const r of Array.isArray(raw) ? raw : []) {
    const id = r?.id; if (typeof id !== 'string' || !validIds.has(id)) continue;
    const c = byId.get(id)!;
    c.feedsInto = filter(r.feedsInto);
    c.gates = filter(r.gates);
    c.affectedBy = filter(r.affectedBy);
    if (typeof r.revealsModuleId === 'string' && r.revealsModuleId) c.revealsModuleId = r.revealsModuleId;
  }

  // Cycle detection on feedsInto. Drop the offending edges.
  const stripCycles = (list: Control[]): Control[] => {
    const adj = new Map<string, string[]>(list.map(c => [c.id, [...c.feedsInto]]));
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const dropEdges = new Set<string>();
    function dfs(u: string, stack: string[]): void {
      color.set(u, GRAY);
      stack.push(u);
      const nexts = adj.get(u) ?? [];
      for (const v of nexts) {
        if ((color.get(v) ?? WHITE) === GRAY) dropEdges.add(`${u}->${v}`);
        else if ((color.get(v) ?? WHITE) === WHITE) dfs(v, stack);
      }
      color.set(u, BLACK); stack.pop();
    }
    for (const c of list) if ((color.get(c.id) ?? WHITE) === WHITE) dfs(c.id, []);
    if (dropEdges.size > 0) {
      console.warn(`   ↪ dropped ${dropEdges.size} cycle edges`);
      for (const c of list) c.feedsInto = c.feedsInto.filter(n => !dropEdges.has(`${c.id}->${n}`));
    }
    return list;
  };

  return stripCycles([...byId.values()]);
}

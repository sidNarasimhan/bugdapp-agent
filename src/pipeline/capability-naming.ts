/**
 * Capability Naming — LLM labels graph-derived capabilities.
 *
 * The capability already exists (came from graph traversal). This phase just
 * gives it a name, intent sentence, success criteria, and narrows doc
 * references. One batched LLM call per module (all capabilities in that
 * module in one request) to keep cost down.
 *
 * Cost: ~$0.02 per module × 8 ≈ $0.15.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../core/llm.js';
import type { AgentStateType, Capability, Control, DAppModule, StructuredDoc } from '../agent/state.js';

const MODEL = process.env.CAPABILITY_NAMING_MODEL ?? 'anthropic/claude-sonnet-4.5';

export function createCapabilityNamingNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config } = state;
    const caps: Capability[] = state.capabilities && state.capabilities.length > 0
      ? state.capabilities
      : (() => { const p = join(config.outputDir, 'capabilities.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const controls: Control[] = state.controls && state.controls.length > 0
      ? state.controls
      : (() => { const p = join(config.outputDir, 'controls.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const modules: DAppModule[] = state.modules && state.modules.length > 0
      ? state.modules
      : (() => { const p = join(config.outputDir, 'modules.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const docs: StructuredDoc[] = state.structuredDocs && state.structuredDocs.length > 0
      ? state.structuredDocs
      : (() => { const p = join(config.outputDir, 'structured-docs.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();

    if (caps.length === 0) {
      console.log('[CapabilityNaming] no capabilities, skipping');
      return {};
    }

    console.log('━━━ Capability Naming: LLM labels graph-derived capabilities ━━━');
    const client = createOpenRouterClient(config.apiKey || process.env.OPENROUTER_API_KEY);

    const controlById = new Map(controls.map(c => [c.id, c]));
    const moduleById = new Map(modules.map(m => [m.id, m]));
    const docById = new Map(docs.map(d => [d.id, d]));

    // Group by module for batched naming
    const byModule = new Map<string, Capability[]>();
    for (const c of caps) {
      if (!byModule.has(c.moduleId)) byModule.set(c.moduleId, []);
      byModule.get(c.moduleId)!.push(c);
    }

    let totalNamed = 0;
    for (const [moduleId, mCaps] of byModule) {
      const mod = moduleById.get(moduleId);
      if (!mod) continue;
      try {
        const raw = await askNaming(client, mod, mCaps, controlById, docById);
        mergeNames(raw, mCaps);
        totalNamed += mCaps.filter(c => c.name).length;
        console.log(`  ✔ ${mod.name}: ${mCaps.length} capabilities named`);
      } catch (e: any) {
        console.warn(`  ✗ ${moduleId}: ${e?.message ?? e}`);
      }
    }

    // Fallback naming for any capability still nameless
    for (const c of caps) {
      if (c.name) continue;
      const mod = moduleById.get(c.moduleId);
      c.name = `${mod?.name ?? 'Unknown'} — variant`;
      c.intent = 'User operates on this module.';
      c.successCriteria = 'Expected post-state observed.';
    }

    writeFileSync(join(config.outputDir, 'capabilities.json'), JSON.stringify(caps, null, 2));
    console.log(`[CapabilityNaming] ${totalNamed}/${caps.length} named via LLM, ${caps.length - totalNamed} fallback`);
    return { capabilities: caps };
  };
}

const SYSTEM = [
  'You label graph-derived capabilities. Each capability came from a real traversal — do NOT invent flows, do NOT reorder steps, do NOT add/remove controls. Just NAME.',
  '',
  'For each capability produce:',
  '- name: human display name (e.g. "Open ZFP Long on ETH-USD with 100x"). Concise, specific.',
  '- intent: 1 sentence of the user goal.',
  '- successCriteria: 1 sentence of what the user verifies after (e.g. "Position row appears in /portfolio with correct size and side").',
  '- docIds: subset of module docs actually relevant (≤4).',
  '',
  'Use the optionChoices to inform the name (if they picked Long + Market + 100x, that\'s in the name).',
  '',
  'Return STRICT JSON: [{id, name, intent, successCriteria, docIds}, ...]. No prose.',
].join('\n');

async function askNaming(
  client: ReturnType<typeof createOpenRouterClient>,
  mod: DAppModule,
  caps: Capability[],
  controlById: Map<string, Control>,
  docById: Map<string, StructuredDoc>,
): Promise<any[]> {
  const payload = {
    module: { id: mod.id, name: mod.name, archetype: mod.archetype, businessPurpose: mod.businessPurpose },
    docs: mod.docSectionIds.map(id => {
      const d = docById.get(id);
      return d ? { id: d.id, title: d.title, topics: d.topics } : null;
    }).filter(Boolean),
    capabilities: caps.map(c => ({
      id: c.id,
      controlPath: c.controlPath.map(cid => {
        const ctrl = controlById.get(cid);
        return ctrl ? { id: cid, name: ctrl.name, kind: ctrl.kind } : { id: cid };
      }),
      optionChoices: c.optionChoices,
      riskClass: c.riskClass,
    })),
  };
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
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

function mergeNames(raw: any[], caps: Capability[]): void {
  const byId = new Map(caps.map(c => [c.id, c]));
  const validDocs = new Set<string>();
  for (const c of caps) for (const d of c.docIds) validDocs.add(d);
  for (const r of Array.isArray(raw) ? raw : []) {
    const cap = byId.get(r?.id);
    if (!cap) continue;
    if (typeof r.name === 'string') cap.name = r.name.slice(0, 120);
    if (typeof r.intent === 'string') cap.intent = r.intent.slice(0, 240);
    if (typeof r.successCriteria === 'string') cap.successCriteria = r.successCriteria.slice(0, 240);
    if (Array.isArray(r.docIds)) cap.docIds = r.docIds.filter((x: any) => typeof x === 'string' && validDocs.has(x)).slice(0, 4);
  }
}

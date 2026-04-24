/**
 * Persona Mapper — LLM pass that turns business modules into intent-level
 * user flows grouped by persona. One LLM call per module (Sonnet 4.5),
 * ~$0.02-0.03 each. For Avantis (8 modules) total ≈ $0.15.
 *
 * Input  : each module's .md (from markdown-emitter) + its components + archetype
 * Output : output/<host>/flows-by-persona.json — array of DAppUserFlow
 *
 * Anti-hallucination: every step's componentIds MUST appear in the module's
 * componentIds set. Flows referencing invented ids are dropped pre-write.
 *
 * Guardrails:
 *   - Skip modules with <3 components (no flows possible)
 *   - Every flow must have a precondition
 *   - Every tx-involving flow must include "wallet connected" in precondition
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../core/llm.js';
import type { AgentStateType, DAppModule, DAppUserFlow } from '../agent/state.js';

const MAPPER_MODEL = process.env.MAPPER_MODEL ?? 'anthropic/claude-sonnet-4.5';

const PERSONAS_BY_ARCHETYPE: Record<string, string[]> = {
  perps: ['new-trader', 'power-user', 'adversarial'],
  swap: ['new-user', 'power-swapper', 'adversarial'],
  lending: ['depositor', 'borrower', 'adversarial'],
  staking: ['staker', 'long-term-holder', 'adversarial'],
  cdp: ['vault-opener', 'leveraged-borrower', 'adversarial'],
  yield: ['yield-farmer', 'risk-averse-lp', 'adversarial'],
  lp: ['liquidity-provider', 'power-lp', 'adversarial'],
  bridge: ['simple-bridger', 'power-bridger', 'adversarial'],
  general: ['casual-user', 'power-user'],
};

export function createPersonaMapperNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { modules, config } = state;
    if (!modules || modules.length === 0) {
      console.log('[PersonaMapper] no modules in state, skipping');
      return {};
    }

    console.log('━━━ Persona Mapper: intent-level user flows per module ━━━');
    const client = createOpenRouterClient(config.apiKey || process.env.OPENROUTER_API_KEY);

    const allFlows: DAppUserFlow[] = [];
    const allModules = flatten(modules);
    for (const m of allModules) {
      if (m.componentIds.length < 3) {
        console.log(`  - skip ${m.name} (${m.componentIds.length} components — too few for real flows)`);
        continue;
      }
      const mdPath = join(config.outputDir, 'knowledge', `${slugFor(m.id)}.md`);
      const md = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : '';
      const personas = PERSONAS_BY_ARCHETYPE[m.archetype ?? 'general'] ?? ['user'];

      let rawFlows: any[] = [];
      try {
        rawFlows = await askMapper(client, m, md, personas);
      } catch (e: any) {
        console.warn(`  ✗ ${m.name} — LLM call failed: ${e?.message ?? e}`);
        continue;
      }
      const valid = validateFlows(rawFlows, m);
      allFlows.push(...valid);
      console.log(`  ✔ ${m.name} — ${valid.length} flows (${rawFlows.length - valid.length} dropped for invalid ids/preconditions)`);
    }

    writeFileSync(join(config.outputDir, 'flows-by-persona.json'), JSON.stringify(allFlows, null, 2));
    const byPersona = groupBy(allFlows, f => f.persona);
    console.log(`[PersonaMapper] ${allFlows.length} total flows across ${Object.keys(byPersona).length} personas`);
    for (const [p, fs] of Object.entries(byPersona)) {
      console.log(`  - ${p}: ${fs.length}`);
    }

    return { userFlows: allFlows };
  };
}

// ── LLM call ────────────────────────────────────────────────────────────

const MAPPER_SYSTEM = [
  'You map a dApp module into real USER FLOWS organized by PERSONA. Not click sequences. Intent-level goals.',
  '',
  'You will get: module name + archetype + module .md (components, entry points, constraints, docs) + a list of personas.',
  '',
  'For each persona, produce 2-4 flows. Each flow:',
  '- id: stable slug "flow:<module-slug>:<flow-name>" (e.g. "flow:trade.zfp:open-long-market")',
  '- moduleId: the input module id verbatim',
  '- persona: exactly one from the input persona list',
  '- intent: 1 sentence describing the user goal (e.g. "Open a 100x ZFP long on ETH-USD with $1 collateral")',
  '- precondition: MUST describe prerequisites. Any flow that submits a tx MUST include "wallet connected".',
  '- steps[]: ordered. Each has description (1 sentence) + componentIds (MUST be from the module\'s components — NO inventing ids) + optional assertion',
  '- postcondition: what user verifies after',
  '- archetype: inherit from module',
  '- riskClass: "safe" (no tx), "medium" (small tx), "high" (large tx / novel state)',
  '- expectedTerminal: best guess of the form state classifier at submit time — "ready-to-action" | "needs-approval" | "unfunded" | "min-amount" | "wrong-network" | "unconnected"',
  '',
  'Hard rules:',
  '- componentIds MUST appear in the module\'s componentIds set (input lists them). Flows with invented ids get DROPPED.',
  '- Keep flows distinct. Don\'t emit "Open Long" five times with different collateral values — just one and let tests parameterize.',
  '- Include one adversarial/boundary flow per module where applicable (e.g. try 251x leverage on ZFP expecting rejection).',
  '- Include one close/inverse flow when the module has an inverse (close position, withdraw, repay).',
  '',
  'Return STRICT JSON: an array of flow objects. No prose. No wrapper.',
].join('\n');

async function askMapper(
  client: ReturnType<typeof createOpenRouterClient>,
  m: DAppModule,
  md: string,
  personas: string[],
): Promise<any[]> {
  const userPayload = {
    module: {
      id: m.id,
      name: m.name,
      archetype: m.archetype,
      componentIds: m.componentIds,
      subModuleNames: m.subModules?.map(s => s.name),
    },
    personas,
    module_markdown: md.slice(0, 4000),
  };
  const resp = await client.messages.create({
    model: MAPPER_MODEL,
    max_tokens: 5000,
    temperature: 0,
    system: MAPPER_SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
  });
  const text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  const parsed = extractJsonArray(text);
  if (parsed.length === 0 && text.length > 0) {
    console.warn(`[PersonaMapper]   LLM returned non-parseable output (${text.length} chars). First 200: ${text.slice(0, 200)}`);
  }
  return parsed;
}

function extractJsonArray(s: string): any[] {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (fenced ? fenced[1] : s).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return []; }
}

// ── Validation ──────────────────────────────────────────────────────────

function validateFlows(raw: any[], m: DAppModule): DAppUserFlow[] {
  if (!Array.isArray(raw)) return [];
  const validComponents = new Set(m.componentIds);
  const clean: DAppUserFlow[] = [];

  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const precondition = String(r.precondition ?? '').trim();
    if (!precondition) continue; // precondition mandatory

    const riskClass = (['safe', 'medium', 'high'] as const).includes(r.riskClass) ? r.riskClass : 'medium';
    // if tx involved, precondition MUST mention wallet connected
    const walletRequired = riskClass !== 'safe';
    if (walletRequired && !/wallet.*connect|connected.*wallet|connected\b/i.test(precondition)) continue;

    const rawSteps: any[] = Array.isArray(r.steps) ? r.steps : [];
    const steps = rawSteps.map((s: any) => ({
      description: String(s?.description ?? '').slice(0, 300),
      componentIds: Array.isArray(s?.componentIds)
        ? s.componentIds.filter((id: any) => typeof id === 'string' && validComponents.has(id))
        : [],
      assertion: s?.assertion ? String(s.assertion).slice(0, 240) : undefined,
    })).filter((s: any) => s.description);

    if (steps.length < 2) continue; // need real steps

    // Drop flows where >30% of step componentIds were invalid
    const totalRefs: number = rawSteps.reduce((n: number, s: any) => n + (Array.isArray(s?.componentIds) ? s.componentIds.length : 0), 0);
    const validRefs = steps.reduce((n, s) => n + s.componentIds.length, 0);
    if (totalRefs > 0 && validRefs / totalRefs < 0.7) continue;

    clean.push({
      id: String(r.id ?? `flow:${slugFor(m.id)}:${slugify(r.intent ?? 'unknown')}`),
      moduleId: m.id,
      persona: String(r.persona ?? 'user').toLowerCase(),
      intent: String(r.intent ?? '').slice(0, 240),
      precondition,
      steps,
      postcondition: String(r.postcondition ?? '').slice(0, 240),
      archetype: m.archetype ?? 'general',
      riskClass,
      expectedTerminal: typeof r.expectedTerminal === 'string' ? r.expectedTerminal : undefined,
    });
  }

  return clean;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function flatten(mods: DAppModule[]): DAppModule[] {
  const o: DAppModule[] = [];
  const walk = (ms: DAppModule[]) => { for (const m of ms) { o.push(m); if (m.subModules?.length) walk(m.subModules); } };
  walk(mods);
  return o;
}

function slugFor(moduleId: string): string {
  return moduleId.replace(/^module:/, '').replace(/:/g, '.');
}

function slugify(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'flow';
}

function groupBy<T, K extends string>(arr: T[], key: (t: T) => K): Record<K, T[]> {
  const out: Record<K, T[]> = {} as any;
  for (const x of arr) {
    const k = key(x);
    (out[k] = out[k] || []).push(x);
  }
  return out;
}

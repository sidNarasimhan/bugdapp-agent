/**
 * Persona Assignment — one LLM call: given all capabilities + their intents,
 * tag each with the relevant personas.
 *
 * Replaces the old persona-mapper (which *invented* flows). Now personas are
 * just metadata tags on already-derived capabilities.
 *
 * Cost: one batched call ~$0.03 total.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../core/llm.js';
import type { AgentStateType, Capability } from '../agent/state.js';

const MODEL = process.env.PERSONA_ASSIGNMENT_MODEL ?? 'anthropic/claude-sonnet-4.5';

export function createPersonaAssignmentNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config } = state;
    const caps: Capability[] = state.capabilities && state.capabilities.length > 0
      ? state.capabilities
      : (() => { const p = join(config.outputDir, 'capabilities.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    if (caps.length === 0) { console.log('[PersonaAssignment] no capabilities, skipping'); return {}; }

    console.log('━━━ Persona Assignment: tag capabilities with personas ━━━');
    const client = createOpenRouterClient(config.apiKey || process.env.OPENROUTER_API_KEY);

    try {
      const raw = await askAssignment(client, caps);
      mergePersonas(raw, caps);
    } catch (e: any) {
      console.warn(`[PersonaAssignment] LLM failed: ${e?.message ?? e}. Falling back to archetype-based defaults.`);
      for (const c of caps) if (c.personas.length === 0) c.personas = defaultPersonas(c);
    }
    const total = caps.reduce((n, c) => n + c.personas.length, 0);
    console.log(`[PersonaAssignment] assigned ${total} persona tags across ${caps.length} capabilities`);
    writeFileSync(join(config.outputDir, 'capabilities.json'), JSON.stringify(caps, null, 2));
    return { capabilities: caps };
  };
}

const PERSONAS = [
  'new-trader', 'power-user', 'adversarial',
  'new-user', 'power-swapper',
  'depositor', 'borrower',
  'staker', 'long-term-holder',
  'yield-farmer', 'risk-averse-lp',
  'liquidity-provider',
  'casual-user',
];

const SYSTEM = [
  'Tag each capability with 1-3 relevant personas from this fixed list:',
  PERSONAS.map(p => `  ${p}`).join('\n'),
  '',
  'Rules:',
  '- If it\'s an edge-case / boundary test, include "adversarial".',
  '- If archetype is "perps", prefer new-trader / power-user / adversarial.',
  '- If archetype is "yield" or "lp", prefer yield-farmer / risk-averse-lp / liquidity-provider / adversarial.',
  '- If module kind is "cross-cutting" or "general" (nav, wallet-connect), use casual-user or new-user.',
  '',
  'Return STRICT JSON: [{id, personas: string[]}]. Only persona names from the list above. No prose.',
].join('\n');

async function askAssignment(client: ReturnType<typeof createOpenRouterClient>, caps: Capability[]): Promise<any[]> {
  const payload = caps.map(c => ({
    id: c.id,
    name: c.name || '(unnamed)',
    intent: c.intent || '(no intent)',
    archetype: c.archetype ?? 'general',
    riskClass: c.riskClass,
    hasEdgeCases: c.edgeCases.length > 0,
  }));
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
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

function mergePersonas(raw: any[], caps: Capability[]): void {
  const valid = new Set(PERSONAS);
  const byId = new Map(caps.map(c => [c.id, c]));
  for (const r of Array.isArray(raw) ? raw : []) {
    const cap = byId.get(r?.id);
    if (!cap) continue;
    if (Array.isArray(r.personas)) {
      cap.personas = r.personas.filter((x: any) => typeof x === 'string' && valid.has(x)).slice(0, 4);
    }
  }
  // Fallback for uncovered capabilities
  for (const c of caps) {
    if (c.personas.length === 0) c.personas = defaultPersonas(c);
  }
}

function defaultPersonas(c: Capability): string[] {
  if (c.edgeCases.length > 0 && c.riskClass !== 'safe') return ['adversarial'];
  if (c.riskClass === 'safe') return ['casual-user'];
  switch (c.archetype) {
    case 'perps': return ['new-trader', 'power-user'];
    case 'swap': return ['new-user', 'power-swapper'];
    case 'lending': return ['depositor', 'borrower'];
    case 'staking': return ['staker'];
    case 'yield': return ['yield-farmer'];
    case 'lp': return ['liquidity-provider'];
    default: return ['casual-user'];
  }
}

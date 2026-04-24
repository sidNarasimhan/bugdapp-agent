/**
 * Control Clustering — cluster DOM atoms into semantic Controls.
 *
 *   Before: [button:"10%", button:"25%", button:"50%", button:"75%", button:"100%"]
 *   After:  Control { kind: "percentage-picker", name: "Collateral Quick-Pick",
 *                     options: ["10%","25%","50%","75%","100%"],
 *                     componentIds: [...the 5 buttons] }
 *
 * One LLM call per module (Sonnet 4.5). Input: the module's raw components.
 * Output: an array of Control objects. Validator enforces that every
 * componentId in a Control exists in the module's components, and every
 * component in the module is assigned to exactly one Control.
 *
 * Cost: ~$0.03 per module × ~8 modules ≈ $0.25.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../core/llm.js';
import type { AgentStateType, Control, ControlKind, DAppModule, KnowledgeGraph } from '../agent/state.js';

const MODEL = process.env.CONTROL_CLUSTERING_MODEL ?? 'anthropic/claude-sonnet-4.5';

const VALID_KINDS: ControlKind[] = [
  'input', 'toggle', 'radio', 'tabs', 'percentage-picker', 'slider', 'dropdown',
  'modal-selector', 'submit-cta', 'link', 'tab', 'button',
];

export function createControlClusteringNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { knowledgeGraph: kg, config } = state;
    const modules: DAppModule[] = state.modules && state.modules.length > 0
      ? state.modules
      : (() => { const p = join(config.outputDir, 'modules.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    if (modules.length === 0) {
      console.log('[ControlClustering] no modules, skipping');
      return { controls: [] };
    }

    console.log('━━━ Control Clustering: DOM atoms → semantic controls ━━━');
    const client = createOpenRouterClient(config.apiKey || process.env.OPENROUTER_API_KEY);

    const allControls: Control[] = [];
    for (const m of modules) {
      if (m.componentIds.length < 1) continue;
      const comps = m.componentIds
        .map(cid => kg.components.find(c => c.id === cid))
        .filter((c: any): c is any => !!c && c.name && !c.disabled);
      if (comps.length === 0) continue;

      try {
        const raw = await askClustering(client, m, comps);
        const valid = validate(raw, m, comps);
        allControls.push(...valid);
        console.log(`  ✔ ${m.name} — ${valid.length} controls from ${comps.length} components`);
        for (const c of valid) {
          const opts = c.options?.length ? ` options=${c.options.length}` : '';
          const kind = c.kind;
          console.log(`      • [${kind}] ${c.name}${opts} (${c.componentIds.length} components)`);
        }
      } catch (e: any) {
        console.warn(`  ✗ ${m.name}: ${e?.message ?? e}`);
      }
    }

    // Synth sibling options for known patterns where crawl captured only one visible option
    synthSiblingOptions(allControls, modules);

    // Back-fill module.controlIds with the newly created controls
    const byModule = new Map<string, string[]>();
    for (const c of allControls) {
      if (!byModule.has(c.moduleId)) byModule.set(c.moduleId, []);
      byModule.get(c.moduleId)!.push(c.id);
    }
    for (const m of modules) {
      m.controlIds = byModule.get(m.id) ?? [];
    }

    writeFileSync(join(config.outputDir, 'controls.json'), JSON.stringify(allControls, null, 2));
    writeFileSync(join(config.outputDir, 'modules.json'), JSON.stringify(modules, null, 2));
    console.log(`[ControlClustering] total ${allControls.length} controls across ${byModule.size} modules`);
    return { controls: allControls, modules };
  };
}

// ── LLM ─────────────────────────────────────────────────────────────────

const SYSTEM = [
  'You cluster DOM atoms into semantic Controls a user would recognize as a single UI element.',
  '',
  'Input: one module with its raw components (buttons, inputs, sliders, switches, etc).',
  '',
  'Output: array of Control objects. Each Control:',
  '- id: slug like "control:<module>:<control-name>" (e.g. "control:trade:collateral-quickpick")',
  '- name: human display name ("Collateral Quick-Pick")',
  '- kind: one of — input | toggle | radio | tabs | percentage-picker | slider | dropdown | modal-selector | submit-cta | link | tab | button',
  '- componentIds: the RAW component ids that make up this control (must come from input)',
  '- options[]: for multi-option controls, the option labels (e.g. ["10%","25%","50%","75%","100%"])',
  '- unit: if applicable ("USDC", "x", "%", etc)',
  '- description: 1 sentence of what user does with this control',
  '',
  'Clustering rules:',
  '- Percentage buttons (10%/25%/50%/75%/100%) → ONE percentage-picker Control with options.',
  '- Tab-like buttons (Market/Limit/Stop) → ONE tabs Control with options.',
  '- Radio-like options (Long/Short) → ONE radio Control.',
  '- A single slider → ONE slider Control (no options).',
  '- A single toggle/switch → ONE toggle Control.',
  '- A single text/number input → ONE input Control.',
  '- Asset/token selector button opening a modal → ONE modal-selector Control. Options list known assets if discoverable.',
  '- Main submit button that changes label by state (Approve / Open Long / Add Funds) → ONE submit-cta Control.',
  '- Individual unique buttons that don\'t cluster with peers → one button/link Control each.',
  '',
  'Hard rules:',
  '- Every componentId in your output MUST come from the input. No inventing.',
  '- Every input component SHOULD appear in exactly one Control. You may skip obviously decorative components (headings, unlabeled nav text).',
  '- Do not output more Controls than input components.',
  '',
  'Return STRICT JSON: array of Control objects. No prose. No wrapper.',
].join('\n');

async function askClustering(client: ReturnType<typeof createOpenRouterClient>, m: DAppModule, comps: any[]): Promise<any[]> {
  const payload = {
    module: { id: m.id, name: m.name, archetype: m.archetype },
    components: comps.map(c => ({ id: c.id, role: c.role, name: String(c.name).slice(0, 50) })),
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

function validate(raw: any[], m: DAppModule, comps: any[]): Control[] {
  if (!Array.isArray(raw)) return [];
  const validCompIds = new Set(comps.map(c => c.id));
  const out: Control[] = [];
  for (const r of raw) {
    if (!r || !r.name) continue;
    const kind = VALID_KINDS.includes(r.kind) ? r.kind as ControlKind : 'button';
    const componentIds = Array.isArray(r.componentIds)
      ? r.componentIds.filter((x: any) => typeof x === 'string' && validCompIds.has(x))
      : [];
    if (componentIds.length === 0) continue;

    const id = typeof r.id === 'string' && r.id
      ? r.id
      : `control:${m.id.replace(/^module:/, '')}:${slug(r.name)}`;

    out.push({
      id,
      moduleId: m.id,
      name: String(r.name).slice(0, 80),
      kind,
      componentIds,
      options: Array.isArray(r.options) ? r.options.map((x: any) => String(x).slice(0, 40)).slice(0, 20) : undefined,
      unit: r.unit ? String(r.unit).slice(0, 20) : undefined,
      description: String(r.description ?? '').slice(0, 240),
      feedsInto: [],
      gates: [],
      affectedBy: [],
    });
  }
  return out;
}

function slug(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'control';
}

/**
 * When crawler snapshot the DOM, only the currently-active option is visible for radios/tabs/
 * modal-selectors. Infer the canonical siblings so capability-derivation can explore them.
 * Purely domain-aware guesses; never invents options for things with already-multiple options.
 */
function synthSiblingOptions(controls: Control[], modules: DAppModule[]): void {
  const moduleById = new Map(modules.map(m => [m.id, m]));
  for (const c of controls) {
    if (Array.isArray(c.options) && c.options.length > 1) continue;
    const existing = (c.options ?? [])[0]?.toLowerCase() ?? '';
    const name = c.name.toLowerCase();
    const mod = moduleById.get(c.moduleId);
    const archetype = mod?.archetype ?? '';

    // Position direction (perps): Long / Short
    if (c.kind === 'radio' && archetype === 'perps' &&
        /direction|side|position/.test(name) &&
        (existing === 'long' || existing === 'short' || existing === '')) {
      c.options = uniqueKeepFirst(['Long', 'Short'], c.options?.[0]);
      continue;
    }
    // Order type (perps/swap): Market / Limit / Stop
    if ((c.kind === 'tabs' || c.kind === 'radio') &&
        (archetype === 'perps' || archetype === 'swap') &&
        /order|market|limit|type/.test(name)) {
      c.options = uniqueKeepFirst(['Market', 'Limit', 'Stop'], c.options?.[0]);
      continue;
    }
    // Asset selector (perps/swap): add canonical siblings alongside the detected one
    if (c.kind === 'modal-selector' && (archetype === 'perps' || archetype === 'swap') &&
        /asset|pair|token/.test(name) &&
        (c.options?.length ?? 0) <= 1) {
      const detected = c.options?.[0];
      const canon = archetype === 'perps'
        ? ['BTCUSD', 'ETHUSD', 'SOLUSD']
        : ['ETH', 'USDC', 'USDT'];
      c.options = uniqueKeepFirst(canon, detected);
      continue;
    }
  }
}

function uniqueKeepFirst(canon: string[], detected?: string): string[] {
  if (!detected) return canon;
  const d = detected.toUpperCase();
  const canonUpper = canon.map(x => x.toUpperCase());
  if (canonUpper.includes(d)) return canon;
  return [detected, ...canon];
}

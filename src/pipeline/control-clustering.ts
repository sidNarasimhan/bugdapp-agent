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
import type { AgentStateType, Control, ControlKind, DAppModule, KGAsset, KnowledgeGraph } from '../agent/state.js';

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

    // Hydrate asset-selector controls from kg.assets — the KG's first-class
    // asset list (populated by the crawler from network price feeds, already
    // includes WTI, XAU, EUR/USD, AAPL, etc). Falls back to canonical siblings
    // for other radio/tabs/modal axes that the DOM only revealed the active
    // option for.
    if (kg.assets?.length) {
      const byGroup = kg.assets.reduce((m, a) => { m[a.group] = (m[a.group] ?? 0) + 1; return m; }, {} as Record<string, number>);
      const summary = Object.entries(byGroup).map(([g, n]) => `${g}:${n}`).join(', ');
      console.log(`[ControlClustering] hydrating from kg.assets: ${kg.assets.length} total (${summary})`);
    }
    synthSiblingOptions(allControls, modules, kg.assets ?? []);

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
function synthSiblingOptions(controls: Control[], modules: DAppModule[], kgAssets: KGAsset[]): void {
  const moduleById = new Map(modules.map(m => [m.id, m]));

  // Flatten kg.assets with cross-class leaders first so downstream variant
  // sampling reaches every asset class within the first few picks. We classify
  // the dApp's own group strings into generic asset classes (crypto, fx,
  // equity, commodity, metal) via keyword match — works across Avantis/Pyth
  // (CRYPTO1/FOREX/...), GMX-style (Crypto/Forex/...), etc.
  const grouped = groupAssetsByClass(kgAssets);
  const classOrder = ['crypto', 'fx', 'equity', 'commodity', 'metal', 'other'];
  const canonicalAssetList: string[] = [];
  const seenSym = new Set<string>();
  // Round 1: one leader per class
  for (const cls of classOrder) {
    for (const a of (grouped.get(cls) ?? []).slice(0, 1)) {
      const sym = displaySymbol(a.symbol);
      if (!seenSym.has(sym)) { seenSym.add(sym); canonicalAssetList.push(sym); }
    }
  }
  // Round 2: everything else, class by class
  for (const cls of classOrder) {
    for (const a of (grouped.get(cls) ?? []).slice(1)) {
      const sym = displaySymbol(a.symbol);
      if (!seenSym.has(sym)) { seenSym.add(sym); canonicalAssetList.push(sym); }
    }
  }

  for (const c of controls) {
    const existing = (c.options ?? [])[0]?.toLowerCase() ?? '';
    const name = c.name.toLowerCase();
    const mod = moduleById.get(c.moduleId);
    const archetype = mod?.archetype ?? '';

    // Position direction (perps): Long / Short
    if (c.kind === 'radio' && archetype === 'perps' &&
        /direction|side|position/.test(name) &&
        (existing === 'long' || existing === 'short' || existing === '')) {
      if (!(Array.isArray(c.options) && c.options.length > 1))
        c.options = uniqueKeepFirst(['Long', 'Short'], c.options?.[0]);
      continue;
    }
    // Order type (perps/swap): Market / Limit / Stop
    if ((c.kind === 'tabs' || c.kind === 'radio') &&
        (archetype === 'perps' || archetype === 'swap') &&
        /order|market|limit|type/.test(name)) {
      if (!(Array.isArray(c.options) && c.options.length > 1))
        c.options = uniqueKeepFirst(['Market', 'Limit', 'Stop'], c.options?.[0]);
      continue;
    }
    // Asset selector: hydrate from the KG's canonical asset list
    if (c.kind === 'modal-selector' && (archetype === 'perps' || archetype === 'swap') &&
        /asset|pair|token/.test(name)) {
      const detected = c.options?.[0];
      const full = canonicalAssetList.length > 0
        ? canonicalAssetList
        : (archetype === 'perps' ? ['BTCUSD', 'ETHUSD', 'SOLUSD'] : ['ETH', 'USDC', 'USDT']);
      c.options = uniqueKeepFirst(full, detected);
      continue;
    }
  }
}

/** Price-feed symbols are usually hyphenated (BTC-USD); UI buttons typically
 *  concatenate (BTCUSD). Strip hyphens to match the DOM. */
function displaySymbol(s: string): string {
  return s.replace(/-/g, '');
}

/** Classify dApp-specific asset group strings into generic asset classes via
 *  keyword match — tolerant across naming conventions (Pyth's CRYPTO1/FOREX,
 *  GMX's Crypto/Forex, raw "commodities"/"metals"). Uses `symbol` as a fallback
 *  hint for metals-inside-commodities (XAU/XAG). */
export function groupAssetsByClass(assets: KGAsset[]): Map<string, KGAsset[]> {
  const out = new Map<string, KGAsset[]>();
  const add = (cls: string, a: KGAsset) => {
    if (!out.has(cls)) out.set(cls, []);
    out.get(cls)!.push(a);
  };
  for (const a of assets) {
    const g = (a.group ?? '').toLowerCase();
    const s = (a.symbol ?? '').toUpperCase();
    if (/^(xau|xag|gold|silver)/.test(s)) { add('metal', a); continue; }
    if (/crypto/.test(g)) { add('crypto', a); continue; }
    if (/forex|\bfx\b/.test(g)) { add('fx', a); continue; }
    if (/equit|stock/.test(g)) { add('equity', a); continue; }
    if (/commodit|energy|oil/.test(g)) { add('commodity', a); continue; }
    if (/metal/.test(g)) { add('metal', a); continue; }
    // Fallback: guess from symbol shape
    if (/^(BTC|ETH|SOL|BNB|ARB|AVAX|DOGE|ADA|DOT|LINK|UNI|MATIC|POL)/.test(s)) add('crypto', a);
    else if (/^(EUR|GBP|AUD|NZD|CHF|JPY|CAD|CNH|BRL|IDR|INR|MXN|ZAR|TRY|SGD|HKD|KRW|USD)/.test(s) && /USD/.test(s)) add('fx', a);
    else if (/^(WTI|BRENT|NAT|GAS|OIL)/.test(s)) add('commodity', a);
    else add('other', a);
  }
  return out;
}

function uniqueKeepFirst(canon: string[], detected?: string): string[] {
  if (!detected) return canon;
  const d = detected.toUpperCase();
  const canonUpper = canon.map(x => x.toUpperCase());
  if (canonUpper.includes(d)) return canon;
  return [detected, ...canon];
}

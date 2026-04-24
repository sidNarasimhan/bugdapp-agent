/**
 * Capability Derivation — NO LLM. Graph traversal over Controls.
 *
 * For each submit-cta Control:
 *   - backward-traverse feedsInto + gates to find all required controls
 *   - enumerate option combinations for multi-option controls (tabs, radio,
 *     percentage-picker, modal-selector if options known)
 *   - each combination = one Capability path variant
 *
 * Output: state.capabilities[] + capabilities.json. Each capability has:
 *   - controlPath: ordered control ids (DAG topological sort)
 *   - optionChoices: {controlId: chosen option}
 *   - moduleId + archetype inherited
 *
 * The LLM does NOT invent these. Every capability maps to a concrete graph
 * path. Names/intents get filled later by Capability Naming.
 *
 * Combinatorial explosion control: skip combinations beyond MAX_VARIANTS per
 * submit-cta (default 10). Prioritize: (Market, canonical asset, moderate
 * leverage) first; then per-option variations.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, Capability, Control, DAppModule } from '../agent/state.js';

const MAX_VARIANTS_PER_SUBMIT = 80;  // bigger budget — real forms have 5-6 axes, asset universe spans 5 groups
const MAX_OPTIONS_SMALL = 3;         // picker with 3 options → expand all
const MAX_OPTIONS_MEDIUM = 5;        // percentage-picker 5 options → keep all
const MAX_OPTIONS_LARGE_MODAL = 6;   // modal-selector with big option universe → pick 6 (Crypto+FX+Eq+Commod+Metal+extra)

export function createCapabilityDerivationNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config } = state;
    const controls: Control[] = state.controls && state.controls.length > 0
      ? state.controls
      : (() => { const p = join(config.outputDir, 'controls.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const modules: DAppModule[] = state.modules && state.modules.length > 0
      ? state.modules
      : (() => { const p = join(config.outputDir, 'modules.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();

    if (controls.length === 0 || modules.length === 0) {
      console.log('[CapabilityDerivation] missing controls or modules — skipping');
      return { capabilities: [] };
    }

    console.log('━━━ Capability Derivation: graph traversal over controls ━━━');

    const byId = new Map(controls.map(c => [c.id, c]));
    const moduleById = new Map(modules.map(m => [m.id, m]));
    const capabilities: Capability[] = [];

    // 1) For each submit-cta, derive capabilities
    const submits = controls.filter(c => c.kind === 'submit-cta');
    for (const submit of submits) {
      const mod = moduleById.get(submit.moduleId);
      if (!mod) continue;

      // Find all controls that feed into this submit (directly or transitively)
      const required = backwardReach(submit.id, byId);
      // Filter to same module
      const sameModule = required.filter(c => c.moduleId === submit.moduleId);

      // Topological sort to get step order
      const ordered = topoSort(sameModule.concat([submit]), byId);

      // Split into config controls (before submit) and submit
      const configControls = ordered.filter(c => c.kind !== 'submit-cta' && c.id !== submit.id);

      // Enumerate variants; stratified so each axis value appears.
      const variants = enumerateVariants(configControls);
      const capped = stratifiedCap(variants, MAX_VARIANTS_PER_SUBMIT);

      for (let i = 0; i < capped.length; i++) {
        const choices = capped[i];
        const capId = `capability:${mod.id.replace(/^module:/, '')}:${submit.id.split(':').pop()}:${i + 1}`;
        const capPath = [...configControls.map(c => c.id), submit.id];

        // Preconditions from module relations
        const preconds: string[] = [];
        for (const dep of mod.relations.dependsOn ?? []) {
          const depMod = moduleById.get(dep);
          if (depMod) preconds.push(`Module "${depMod.name}" completed first`);
        }
        // If any control is a modal-selector or has wallet implications, add wallet
        if (mod.kind === 'primary' && sameModule.some(c => c.kind === 'submit-cta' || c.kind === 'slider')) {
          if (!preconds.some(p => /wallet/i.test(p))) preconds.push('Wallet connected');
        }

        capabilities.push({
          id: capId,
          moduleId: mod.id,
          name: '',  // filled by Capability Naming
          intent: '',
          preconditions: preconds,
          controlPath: capPath,
          optionChoices: choices,
          docIds: mod.docSectionIds,
          constraintIds: mod.constraintIds,
          successCriteria: '',  // filled by naming
          personas: [],
          edgeCases: [],  // filled by edge-case-derivation
          archetype: mod.archetype,
          riskClass: classifyRisk(mod, sameModule.concat([submit])),
        });
      }
    }

    // 2) For modules WITHOUT a submit-cta, derive informational capabilities
    //    (passive flows: view / navigate) — one capability per primary linkish
    //    or tab control, or one generic "browse module" capability.
    for (const m of modules) {
      const mControls = controls.filter(c => c.moduleId === m.id);
      if (mControls.some(c => c.kind === 'submit-cta')) continue;
      // Only emit for primary modules with meaningful content
      if (m.kind !== 'primary' || mControls.length < 2) continue;

      const capId = `capability:${m.id.replace(/^module:/, '')}:browse`;
      capabilities.push({
        id: capId,
        moduleId: m.id,
        name: '', intent: '',
        preconditions: m.relations.dependsOn?.length
          ? [`Module "${moduleById.get(m.relations.dependsOn[0])?.name ?? 'precondition'}" completed first`]
          : [],
        controlPath: mControls.map(c => c.id),
        optionChoices: {},
        docIds: m.docSectionIds,
        constraintIds: m.constraintIds,
        successCriteria: '',
        personas: [],
        edgeCases: [],
        archetype: m.archetype,
        riskClass: 'safe',
      });
    }

    const byModule: Record<string, number> = {};
    for (const c of capabilities) byModule[c.moduleId] = (byModule[c.moduleId] || 0) + 1;
    console.log(`[CapabilityDerivation] ${capabilities.length} capabilities derived`);
    for (const [mid, n] of Object.entries(byModule)) console.log(`  - ${mid}: ${n}`);

    writeFileSync(join(config.outputDir, 'capabilities.json'), JSON.stringify(capabilities, null, 2));
    return { capabilities };
  };
}

// ── Traversal helpers ──────────────────────────────────────────────────

/** Reverse-BFS from a submit-cta over feedsInto to find all upstream controls. */
function backwardReach(submitId: string, byId: Map<string, Control>): Control[] {
  const inbound = new Map<string, string[]>();
  for (const c of byId.values()) {
    for (const to of c.feedsInto) {
      if (!inbound.has(to)) inbound.set(to, []);
      inbound.get(to)!.push(c.id);
    }
  }
  const reached = new Set<string>();
  const q: string[] = [submitId];
  while (q.length) {
    const cur = q.shift()!;
    for (const parent of inbound.get(cur) ?? []) {
      if (reached.has(parent)) continue;
      reached.add(parent);
      q.push(parent);
    }
  }
  return [...reached].map(id => byId.get(id)!).filter(Boolean);
}

/** Kahn's algorithm on a subset + a sink (submit). */
function topoSort(controls: Control[], byId: Map<string, Control>): Control[] {
  const nodes = new Map(controls.map(c => [c.id, c]));
  const inDeg = new Map<string, number>();
  for (const c of nodes.values()) inDeg.set(c.id, 0);
  for (const c of nodes.values()) {
    for (const to of c.feedsInto) {
      if (nodes.has(to)) inDeg.set(to, (inDeg.get(to) ?? 0) + 1);
    }
  }
  const q: string[] = [];
  for (const [id, d] of inDeg) if (d === 0) q.push(id);
  const out: Control[] = [];
  while (q.length) {
    const id = q.shift()!;
    const c = nodes.get(id)!;
    out.push(c);
    for (const to of c.feedsInto) {
      if (!nodes.has(to)) continue;
      inDeg.set(to, inDeg.get(to)! - 1);
      if (inDeg.get(to) === 0) q.push(to);
    }
  }
  return out;
}

/** Enumerate Cartesian product of STRUCTURAL axes only. Modal-selectors are
 *  excluded — asset selection is a test DATA parameter, not a capability shape.
 *  Long/Short×Market/Limit/Stop×ZFP×TPSL×Collateral = the legitimate shape space.
 *  The full asset universe stays on the Control and is consumed by spec-gen
 *  as data-driven test rows. */
function enumerateVariants(controls: Control[]): Record<string, string>[] {
  const axes: Array<{ id: string; options: string[] }> = [];
  for (const c of controls) {
    const opts = Array.isArray(c.options) ? c.options : [];
    const kind = c.kind;
    if (kind === 'modal-selector') continue; // handled as data parameter, not shape axis
    if (opts.length > 1) {
      let cap: number;
      if (kind === 'radio' || kind === 'tabs' || kind === 'toggle') cap = MAX_OPTIONS_SMALL;
      else if (kind === 'percentage-picker' || kind === 'dropdown') cap = MAX_OPTIONS_MEDIUM;
      else cap = MAX_OPTIONS_SMALL;
      axes.push({ id: c.id, options: opts.slice(0, cap) });
    } else if (kind === 'toggle' && opts.length === 0) {
      // bare toggle without explicit options: vary on/off
      axes.push({ id: c.id, options: ['off', 'on'] });
    }
  }
  if (axes.length === 0) return [{}];

  // Full Cartesian
  let out: Record<string, string>[] = [{}];
  for (const ax of axes) {
    const next: Record<string, string>[] = [];
    for (const combo of out) {
      for (const opt of ax.options) next.push({ ...combo, [ax.id]: opt });
    }
    out = next;
  }
  return out;
}

/** Pick N variants while ensuring every axis value appears at least once if budget allows.
 *  Algorithm:
 *   1. Include the canonical (first-option-everywhere) variant.
 *   2. For each axis and each option, include the "canonical + flip-this-axis-to-option" variant
 *      if not already taken — guarantees axis-wide coverage in |axes + max options| variants.
 *   3. Then fill remaining budget by round-robining through the full combo list skipping dupes. */
function stratifiedCap(all: Record<string, string>[], N: number): Record<string, string>[] {
  if (all.length <= N) return all;
  const keyOf = (c: Record<string, string>) => Object.entries(c).sort().map(([k, v]) => `${k}=${v}`).join('|');
  const pool = all.slice();
  const out: Record<string, string>[] = [];
  const seen = new Set<string>();
  const take = (v: Record<string, string>) => {
    const k = keyOf(v);
    if (seen.has(k)) return false;
    seen.add(k);
    out.push(v);
    return true;
  };
  // 1) canonical = first combo
  take(pool[0]);
  // 2) axis-wise flips (each option of each axis at least once)
  const axes: Record<string, Set<string>> = {};
  for (const v of pool) for (const [k, val] of Object.entries(v)) {
    if (!axes[k]) axes[k] = new Set();
    axes[k].add(val);
  }
  for (const [axis, values] of Object.entries(axes)) {
    for (const val of values) {
      if (out.length >= N) return out;
      // find a variant in pool where this axis=val, prefer minimum diff from canonical
      const cand = pool.find(v => v[axis] === val && !seen.has(keyOf(v)));
      if (cand) take(cand);
    }
  }
  // 3) fill by striding through the rest
  if (out.length < N) {
    const stride = Math.max(1, Math.floor(pool.length / (N - out.length + 1)));
    for (let i = 0; i < pool.length && out.length < N; i += stride) {
      if (!seen.has(keyOf(pool[i]))) take(pool[i]);
    }
    // If still short, take anything remaining
    for (const v of pool) {
      if (out.length >= N) break;
      if (!seen.has(keyOf(v))) take(v);
    }
  }
  return out;
}

function classifyRisk(m: DAppModule, ctrls: Control[]): 'safe' | 'medium' | 'high' {
  const hasSubmit = ctrls.some(c => c.kind === 'submit-cta');
  if (!hasSubmit) return 'safe';
  // Large leverage / high-value perps = high
  if (m.archetype === 'perps' || m.archetype === 'cdp') return 'high';
  if (['swap', 'lending', 'yield', 'lp', 'staking'].includes(m.archetype ?? '')) return 'medium';
  return 'medium';
}

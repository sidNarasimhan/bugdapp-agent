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

const MAX_VARIANTS_PER_SUBMIT = 8;
const MAX_OPTIONS_EXPANSION_PER_CONTROL = 3;  // tabs/radio: enumerate all; large sets: top-3

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

      // Enumerate variants
      const variants = enumerateVariants(configControls);
      const capped = variants.slice(0, MAX_VARIANTS_PER_SUBMIT);

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
          riskClass: classifyRisk(mod, sameModule),
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

/** Enumerate combinations of options across multi-option controls.
 *  Cap each control's options at MAX_OPTIONS_EXPANSION_PER_CONTROL to keep explosion small. */
function enumerateVariants(controls: Control[]): Record<string, string>[] {
  const variable = controls.filter(c => Array.isArray(c.options) && c.options.length > 1);
  if (variable.length === 0) return [{}];
  const axes: Array<{ id: string; options: string[] }> = variable.map(c => ({
    id: c.id,
    options: (c.options ?? []).slice(0, MAX_OPTIONS_EXPANSION_PER_CONTROL),
  }));
  const out: Record<string, string>[] = [{}];
  for (const ax of axes) {
    const next: Record<string, string>[] = [];
    for (const combo of out) {
      for (const opt of ax.options) next.push({ ...combo, [ax.id]: opt });
    }
    out.length = 0;
    out.push(...next);
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

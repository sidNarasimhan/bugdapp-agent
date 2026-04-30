/**
 * Explorer Ingest — reads `exploration.json` (output of phase 17 explorer)
 * and extracts structured deltas the rest of the pipeline can consume:
 *
 *   - new constraints surfaced at runtime (UI validation hints, error
 *     messages: "minimum X", "maximum Y", "exceeds available", etc.)
 *   - new state observations (modals opened, errors shown, warnings raised)
 *   - new transitions (click X → snapshot showed Y appeared)
 *
 * Why heuristic, not LLM: explorer already paid the LLM for the walk. This
 * step is just structuring its observations so kg-assemble can fold them in.
 * If exploration.json is missing/sparse, ingest is a no-op — the pipeline
 * degrades gracefully.
 *
 * Output:
 *   - mutates state.dappConstraints (appends UI-discovered constraints)
 *   - writes exploration-deltas.json so state-extractor + spec-gen can read
 *     observed states/transitions per module without parsing raw observations
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, DAppConstraint } from '../agent/state.js';

interface RawExplorationReport {
  moduleId: string;
  moduleName: string;
  outcome: string;
  summary: string;
  observations?: Array<{ iteration: number; tool: string; output: string }>;
}

interface RawExploration {
  generatedAt?: string;
  modulesExplored?: number;
  perModule?: RawExplorationReport[];
}

export interface ConstraintDelta {
  moduleId: string;
  text: string;       // verbatim UI text
  parsedBound?: { min?: number; max?: number; unit?: string };
  source: 'error' | 'validation-hint' | 'warning' | 'summary';
}

export interface StateDelta {
  moduleId: string;
  label: string;          // e.g. "AssetSelectorModal_Open"
  observedAfterTool?: string;
  observedAfterRef?: string;
  isError?: boolean;
}

export interface TransitionDelta {
  moduleId: string;
  fromObservation: string;  // brief context
  triggeringTool: string;
  triggeringRef?: string;
  resultingStateLabel?: string;
}

export interface ExplorationDeltas {
  generatedAt: string;
  source: string;            // path to exploration.json
  perModule: Array<{
    moduleId: string;
    moduleName: string;
    constraints: ConstraintDelta[];
    states: StateDelta[];
    transitions: TransitionDelta[];
  }>;
  totals: { constraints: number; states: number; transitions: number };
}

export function createExplorerIngestNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config } = state;
    const explorationPath = join(config.outputDir, 'exploration.json');
    if (!existsSync(explorationPath)) {
      console.log('[explorer-ingest] no exploration.json — skipping (degrade gracefully)');
      return {};
    }

    let raw: RawExploration;
    try {
      raw = JSON.parse(readFileSync(explorationPath, 'utf-8'));
    } catch (e: any) {
      console.warn(`[explorer-ingest] could not parse exploration.json: ${e?.message ?? e}`);
      return {};
    }

    console.log('━━━ Explorer Ingest: mining deltas from exploration.json ━━━');

    const perModule: ExplorationDeltas['perModule'] = [];
    const newConstraintsForState: DAppConstraint[] = [];

    for (const r of raw.perModule ?? []) {
      const constraints = mineConstraints(r);
      const states = mineStates(r);
      const transitions = mineTransitions(r);
      perModule.push({
        moduleId: r.moduleId,
        moduleName: r.moduleName,
        constraints,
        states,
        transitions,
      });

      // Promote each constraint delta into a real DAppConstraint so
      // edge-case-derivation (when re-run) sees them. We dedupe on text.
      for (const c of constraints) {
        const id = `constraint:explorer:${r.moduleId}:${c.source}:${hashShort(c.text)}`;
        newConstraintsForState.push({
          id,
          name: c.text.slice(0, 120),
          value: c.text.slice(0, 120),
          bounds: c.parsedBound,
          scope: r.moduleName,
          source: 'observed',
          testImplication: `Surfaced at runtime in ${r.moduleName}: ${c.text.slice(0, 200)}`,
          appliesToModuleId: r.moduleId,
        });
      }
    }

    const totals = perModule.reduce(
      (acc, m) => ({
        constraints: acc.constraints + m.constraints.length,
        states: acc.states + m.states.length,
        transitions: acc.transitions + m.transitions.length,
      }),
      { constraints: 0, states: 0, transitions: 0 },
    );

    const deltas: ExplorationDeltas = {
      generatedAt: new Date().toISOString(),
      source: explorationPath,
      perModule,
      totals,
    };
    writeFileSync(join(config.outputDir, 'exploration-deltas.json'), JSON.stringify(deltas, null, 2));
    console.log(`[explorer-ingest] mined ${totals.constraints} constraints + ${totals.states} states + ${totals.transitions} transitions across ${perModule.length} modules`);

    // Append to dappConstraints (dedup by id)
    const existing = state.dappConstraints ?? [];
    const seen = new Set(existing.map(c => c.id));
    const merged = [...existing];
    for (const c of newConstraintsForState) {
      if (!seen.has(c.id)) { merged.push(c); seen.add(c.id); }
    }
    return { dappConstraints: merged };
  };
}

// ── Mining heuristics ────────────────────────────────────────────────────

const CONSTRAINT_PATTERNS: Array<{ rx: RegExp; src: ConstraintDelta['source'] }> = [
  // "Minimum 100 USDC", "Min: 0.01 ETH", "at least 5x"
  { rx: /\b(?:minimum|min|at\s+least)\b[:\s]*([0-9]+(?:\.[0-9]+)?)\s*(usdc|usd|eth|btc|x|%)?/gi, src: 'validation-hint' },
  // "Maximum 1000", "Max: 250x", "up to 500", "no more than X"
  { rx: /\b(?:maximum|max|up\s+to|no\s+more\s+than)\b[:\s]*([0-9]+(?:\.[0-9]+)?)\s*(usdc|usd|eth|btc|x|%)?/gi, src: 'validation-hint' },
  // "Insufficient X", "Exceeds Y"
  { rx: /\b(?:insufficient|exceeds|cannot\s+exceed|must\s+be\s+(?:less|greater)\s+than)\b[^.;\n]{1,80}/gi, src: 'error' },
  // "Required", "must enter", "missing"
  { rx: /\b(?:must\s+(?:be|enter|provide|select)|required\s+field|cannot\s+be\s+empty)\b[^.;\n]{1,80}/gi, src: 'validation-hint' },
  // Warnings
  { rx: /\b(?:warning|caution|risk)[:\s][^.;\n]{1,100}/gi, src: 'warning' },
];

function mineConstraints(r: RawExplorationReport): ConstraintDelta[] {
  const out: ConstraintDelta[] = [];
  const seen = new Set<string>();
  // Mine both observations + the LLM's own summary
  const haystack = [
    r.summary ?? '',
    ...(r.observations ?? []).map(o => o.output ?? ''),
  ].join('\n');
  for (const { rx, src } of CONSTRAINT_PATTERNS) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(haystack)) !== null) {
      const text = m[0].trim();
      if (text.length < 4 || text.length > 200) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Try to parse a numeric bound
      const num = m[1] ? Number(m[1]) : undefined;
      const unit = m[2]?.toLowerCase();
      const bound = num !== undefined
        ? (/min|at\s+least/i.test(text) ? { min: num, unit } : /max|up\s+to|no\s+more/i.test(text) ? { max: num, unit } : undefined)
        : undefined;
      out.push({ moduleId: r.moduleId, text, parsedBound: bound, source: src });
    }
  }
  // Fallback: mine the summary for "STOPPED at" / "could not" / "blocked because"
  if (r.summary) {
    const blockerRx = /\b(?:stopped|blocked|could\s+not|unable\s+to|prevented)\b[^.;\n]{4,120}/gi;
    let m: RegExpExecArray | null;
    while ((m = blockerRx.exec(r.summary)) !== null) {
      const text = m[0].trim();
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ moduleId: r.moduleId, text, source: 'summary' });
    }
  }
  return out;
}

function mineStates(r: RawExplorationReport): StateDelta[] {
  const out: StateDelta[] = [];
  const seen = new Set<string>();
  for (const o of r.observations ?? []) {
    const text = o.output ?? '';
    // Modal-open detection: dialog role appears in snapshot
    if (o.tool === 'browser_snapshot') {
      const modalMatch = text.match(/\[(?:dialog|alertdialog)\]\s*"([^"\n]{1,80})"/);
      if (modalMatch) {
        const label = `Modal_${slug(modalMatch[1])}_Open`;
        if (!seen.has(label)) {
          seen.add(label);
          out.push({ moduleId: r.moduleId, label, observedAfterTool: previousTool(r, o.iteration) });
        }
      }
      // Error/warning rendered in snapshot
      const errMatch = text.match(/\[(?:alert|status)\]\s*"([^"\n]{1,80})"/);
      if (errMatch) {
        const label = `Error_${slug(errMatch[1])}`;
        if (!seen.has(label)) {
          seen.add(label);
          out.push({ moduleId: r.moduleId, label, observedAfterTool: previousTool(r, o.iteration), isError: true });
        }
      }
    }
  }
  return out;
}

function mineTransitions(r: RawExplorationReport): TransitionDelta[] {
  const out: TransitionDelta[] = [];
  const obs = r.observations ?? [];
  for (let i = 0; i < obs.length - 1; i++) {
    const cur = obs[i];
    const next = obs[i + 1];
    if (cur.tool !== 'browser_click' && cur.tool !== 'browser_type') continue;
    if (next.tool !== 'browser_snapshot') continue;
    const refMatch = cur.output.match(/\[ref=(e\d+)\]/);
    const modalMatch = next.output.match(/\[(?:dialog|alertdialog)\]\s*"([^"\n]{1,80})"/);
    if (modalMatch) {
      out.push({
        moduleId: r.moduleId,
        fromObservation: cur.output.slice(0, 80),
        triggeringTool: cur.tool,
        triggeringRef: refMatch?.[1],
        resultingStateLabel: `Modal_${slug(modalMatch[1])}_Open`,
      });
    }
  }
  return out;
}

function previousTool(r: RawExplorationReport, iter: number): string | undefined {
  const obs = r.observations ?? [];
  for (let i = obs.length - 1; i >= 0; i--) {
    if (obs[i].iteration < iter && obs[i].tool !== 'browser_snapshot') return obs[i].tool;
  }
  return undefined;
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'Unnamed';
}

function hashShort(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

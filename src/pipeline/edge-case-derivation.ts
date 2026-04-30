/**
 * Edge Case Derivation — NO LLM. Derive boundary/invalid test variants per
 * capability from its applicable constraints.
 *
 * Three sources of edge cases:
 *   1. constraints with numeric bounds → generate min-1 and max+1 variants
 *   2. constraints about invariants ("market orders only") → generate
 *      non-matching-value variants
 *   3. cross-cutting preconditions → wallet-not-connected / wrong-network
 *      variants attach to every tx-involving capability
 *
 * Input: state.capabilities + state.dappConstraints (or from disk).
 * Input constraints can come from kg.constraints (old pipeline) or
 * dappConstraints (new). We merge both.
 *
 * Output: fills Capability.edgeCases + writes updated capabilities.json.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, Capability, CapabilityEdgeCase, Control, DAppConstraint, KnowledgeGraph } from '../agent/state.js';

export function createEdgeCaseDerivationNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config, knowledgeGraph: kg } = state;
    const caps: Capability[] = state.capabilities && state.capabilities.length > 0
      ? state.capabilities
      : (() => { const p = join(config.outputDir, 'capabilities.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const controls: Control[] = state.controls && state.controls.length > 0
      ? state.controls
      : (() => { const p = join(config.outputDir, 'controls.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();

    if (caps.length === 0) {
      console.log('[EdgeCaseDerivation] no capabilities, skipping');
      return {};
    }

    console.log('━━━ Edge Case Derivation: constraint × capability ━━━');

    const constraints = collectConstraints(state, kg);
    console.log(`[EdgeCaseDerivation] ${constraints.length} constraints available`);

    const controlById = new Map(controls.map(c => [c.id, c]));

    let totalCases = 0;
    for (const cap of caps) {
      const cases: CapabilityEdgeCase[] = [];
      const applicable = constraints.filter(k => appliesTo(k, cap, controlById));
      for (const c of applicable) {
        cases.push(...generateEdgeCases(c, cap, controlById));
      }
      // Cross-cutting: tx-involving capability gets a "wallet disconnected" edge case
      if (cap.riskClass !== 'safe') {
        cases.push({
          id: `${cap.id}:edge:unconnected`,
          name: 'Attempt without wallet connected',
          controlId: cap.controlPath[cap.controlPath.length - 1],
          invalidValue: 'no wallet',
          expectedRejection: 'Submit CTA should show "Connect Wallet" / "Login"; terminal state = unconnected',
          constraintId: 'precondition:wallet',
        });
        cases.push({
          id: `${cap.id}:edge:wrong-network`,
          name: 'Attempt on wrong network',
          controlId: cap.controlPath[cap.controlPath.length - 1],
          invalidValue: 'different chain',
          expectedRejection: 'Submit CTA should show "Switch Network"; terminal state = wrong-network',
          constraintId: 'precondition:network',
        });
      }
      cap.edgeCases = cases;
      cap.personas = defaultPersonas(cap);
      totalCases += cases.length;
    }

    writeFileSync(join(config.outputDir, 'capabilities.json'), JSON.stringify(caps, null, 2));
    const totalPersonas = caps.reduce((n, c) => n + c.personas.length, 0);
    console.log(`[EdgeCaseDerivation] derived ${totalCases} edge cases + ${totalPersonas} persona tags across ${caps.length} capabilities`);
    return { capabilities: caps };
  };
}

/** Heuristic persona tagger keyed on archetype + risk + edge-cases. Replaces
 *  the old per-dApp LLM Persona Assignment phase — that one only added marginal
 *  naming polish on top of this same fallback. */
function defaultPersonas(c: Capability): string[] {
  if (c.edgeCases.length > 0 && c.riskClass !== 'safe') return ['adversarial'];
  if (c.riskClass === 'safe') return ['casual-user'];
  switch (c.archetype) {
    case 'perps':   return ['new-trader', 'power-user'];
    case 'swap':    return ['new-user', 'power-swapper'];
    case 'lending': return ['depositor', 'borrower'];
    case 'staking': return ['staker'];
    case 'yield':   return ['yield-farmer'];
    case 'lp':      return ['liquidity-provider'];
    default:        return ['casual-user'];
  }
}

// ── Sources of constraints ──────────────────────────────────────────────

function collectConstraints(state: AgentStateType, kg: KnowledgeGraph): DAppConstraint[] {
  const out: DAppConstraint[] = [];
  // New structured constraints
  if (state.dappConstraints?.length) out.push(...state.dappConstraints);

  // Old KG constraints (back-compat)
  for (let i = 0; i < (kg.constraints ?? []).length; i++) {
    const c: any = kg.constraints[i];
    const name = String(c.name ?? c.rule ?? 'constraint').slice(0, 120);
    const value = String(c.value ?? '').slice(0, 120);
    const bounds = parseBounds(name, value);
    out.push({
      id: c.id ?? `constraint:kg:${i}`,
      name,
      value,
      bounds,
      scope: String(c.scope ?? ''),
      source: 'docs',
      testImplication: String(c.testImplication ?? '').slice(0, 240),
    });
  }

  // Also mine structured docs' `rules` as lightweight constraints
  const docs = state.structuredDocs ?? [];
  for (const d of docs) {
    for (let i = 0; i < d.rules.length; i++) {
      const rule = d.rules[i];
      const bounds = parseBounds(rule, rule);
      if (bounds && (bounds.min !== undefined || bounds.max !== undefined)) {
        out.push({
          id: `constraint:doc:${d.id}:${i}`,
          name: rule.slice(0, 120),
          value: rule.slice(0, 120),
          bounds,
          scope: d.title,
          source: 'docs',
          testImplication: `From docs: ${rule}`,
        });
      }
    }
  }

  return out;
}

function parseBounds(name: string, value: string): { min?: number; max?: number; unit?: string } | undefined {
  const text = `${name} ${value}`.toLowerCase();
  const out: { min?: number; max?: number; unit?: string } = {};
  // Range: "75-250x", "1 to 500", "$100-$500"
  const range = text.match(/(\d+(?:\.\d+)?)\s*[-–to]+\s*(\d+(?:\.\d+)?)\s*(x|%|usd|usdc)?/);
  if (range) {
    out.min = Number(range[1]); out.max = Number(range[2]);
    if (range[3]) out.unit = range[3];
    return out;
  }
  // Max N
  const maxM = text.match(/max(?:imum)?.*?(\d+(?:\.\d+)?)\s*(x|%|usd|usdc)?/);
  if (maxM) { out.max = Number(maxM[1]); if (maxM[2]) out.unit = maxM[2]; }
  // Min N
  const minM = text.match(/min(?:imum)?.*?(\d+(?:\.\d+)?)\s*(x|%|usd|usdc)?/);
  if (minM) { out.min = Number(minM[1]); if (minM[2]) out.unit = minM[2]; }
  if (out.min === undefined && out.max === undefined) return undefined;
  return out;
}

// ── Applicability ──────────────────────────────────────────────────────

/** Market-level invariants (OI caps, TVL caps, protocol-wide rules) are NOT user-rejectable —
 *  a user cannot "set OI to 91%". Filter them out. */
function isMarketInvariant(c: DAppConstraint): boolean {
  const blob = `${c.name} ${c.value}`.toLowerCase();
  return /\b(open interest|oi\b|tvl|market[- ]making|total supply|protocol[- ]wide|cap on|system[- ]wide)\b/.test(blob);
}

/** Detect which asset-class (if any) a constraint applies to by looking for
 *  class keywords in its name, value, scope, or testImplication. Returns
 *  undefined if the constraint is universal (applies regardless of asset).
 *  Generic — keyword-level, no hardcoded asset names. */
function detectAssetClass(c: DAppConstraint): string | undefined {
  const blob = `${c.name} ${c.value} ${c.scope ?? ''} ${c.testImplication ?? ''}`.toLowerCase();
  if (/\bforex\b|\bfx\b|\bcurrenc/.test(blob)) return 'fx';
  if (/\bcommodit|\boil\b|\bgas\b|\benergy\b/.test(blob)) return 'commodity';
  if (/\bequit|\bstock\b/.test(blob)) return 'equity';
  if (/\bmetal\b|\bgold\b|\bsilver\b/.test(blob)) return 'metal';
  if (/\bcrypto\b|\bbtc\b|\beth\b|\bperp crypto\b/.test(blob)) return 'crypto';
  return undefined;
}

function appliesTo(c: DAppConstraint, cap: Capability, byId: Map<string, Control>): boolean {
  if (isMarketInvariant(c)) return false;

  // Explicit link
  if (c.appliesToCapabilityId === cap.id) return true;
  if (c.appliesToModuleId && c.appliesToModuleId === cap.moduleId) return true;
  if (c.appliesToControlId && cap.controlPath.includes(c.appliesToControlId)) return true;

  // Heuristic match: constraint must name a concept that matches a user-settable control in path
  const blob = `${c.name} ${c.value}`.toLowerCase();
  for (const cid of cap.controlPath) {
    const ctrl = byId.get(cid);
    if (!ctrl) continue;
    // Only user-value-bearing controls count for name match
    const userSettable = ctrl.kind === 'input' || ctrl.kind === 'slider' || ctrl.kind === 'percentage-picker';
    if (!userSettable) continue;
    if (ctrl.name && blob.includes(ctrl.name.toLowerCase().slice(0, 20))) return true;
    if (ctrl.unit && blob.includes(ctrl.unit.toLowerCase())) return true;
    if (ctrl.kind === 'slider' && /\bleverage\b|\brate\b/.test(blob)) return true;
  }
  // Tight keyword match for user-input concepts
  if (cap.riskClass !== 'safe' && /\b(leverage|collateral|position size|trade size|amount)\b/i.test(c.name)) return true;
  return false;
}

// ── Generation ─────────────────────────────────────────────────────────

function generateEdgeCases(c: DAppConstraint, cap: Capability, byId: Map<string, Control>): CapabilityEdgeCase[] {
  const out: CapabilityEdgeCase[] = [];
  const targetControl = findTargetControl(c, cap, byId);
  if (!targetControl) return out;
  const assetClass = detectAssetClass(c);

  if (c.bounds?.min !== undefined) {
    const v = Math.max(0, c.bounds.min - (c.bounds.unit === 'x' ? 1 : 0.01));
    out.push({
      id: `${cap.id}:edge:${c.id}:below-min`,
      name: `Attempt below ${c.name} (set ${targetControl.name} to ${v}${c.bounds.unit ?? ''})`,
      controlId: targetControl.id,
      invalidValue: `${v}${c.bounds.unit ?? ''}`,
      expectedRejection: c.testImplication || `Should reject values below ${c.bounds.min}${c.bounds.unit ?? ''}`,
      constraintId: c.id,
      appliesToAssetClass: assetClass,
    });
  }
  if (c.bounds?.max !== undefined) {
    const v = c.bounds.max + (c.bounds.unit === 'x' ? 1 : 0.01);
    out.push({
      id: `${cap.id}:edge:${c.id}:above-max`,
      name: `Attempt above ${c.name} (set ${targetControl.name} to ${v}${c.bounds.unit ?? ''})`,
      controlId: targetControl.id,
      invalidValue: `${v}${c.bounds.unit ?? ''}`,
      expectedRejection: c.testImplication || `Should reject values above ${c.bounds.max}${c.bounds.unit ?? ''}`,
      constraintId: c.id,
      appliesToAssetClass: assetClass,
    });
  }
  return out;
}

/** Find a control in the capability's path that can legitimately carry a NUMERIC bound
 *  value. Only value-bearing kinds qualify (input/slider/percentage-picker). Never
 *  radio/tabs/modal-selector/toggle — those take labels, not numbers. */
function findTargetControl(c: DAppConstraint, cap: Capability, byId: Map<string, Control>): Control | null {
  if (c.appliesToControlId) {
    const ctrl = byId.get(c.appliesToControlId);
    if (ctrl && isValueBearing(ctrl)) return ctrl;
  }
  const blob = `${c.name} ${c.value}`.toLowerCase();
  // Leverage-like → slider
  if (/\bleverage\b/.test(blob)) {
    for (const cid of cap.controlPath) {
      const ctrl = byId.get(cid);
      if (ctrl?.kind === 'slider') return ctrl;
    }
  }
  // Amount/collateral-like → input, then percentage-picker
  if (/\b(amount|position|collateral|size|trade)\b/.test(blob)) {
    for (const cid of cap.controlPath) {
      const ctrl = byId.get(cid);
      if (ctrl?.kind === 'input') return ctrl;
    }
    for (const cid of cap.controlPath) {
      const ctrl = byId.get(cid);
      if (ctrl?.kind === 'percentage-picker') return ctrl;
    }
  }
  // Unit-based match (e.g. "%" → percentage-picker, "USDC" → input)
  if (c.bounds?.unit === '%') {
    for (const cid of cap.controlPath) {
      const ctrl = byId.get(cid);
      if (ctrl?.kind === 'percentage-picker') return ctrl;
    }
  }
  if (c.bounds?.unit === 'x') {
    for (const cid of cap.controlPath) {
      const ctrl = byId.get(cid);
      if (ctrl?.kind === 'slider') return ctrl;
    }
  }
  // Last resort: first value-bearing control in path
  for (const cid of cap.controlPath) {
    const ctrl = byId.get(cid);
    if (ctrl && isValueBearing(ctrl)) return ctrl;
  }
  return null;
}

function isValueBearing(ctrl: Control): boolean {
  return ctrl.kind === 'input' || ctrl.kind === 'slider' || ctrl.kind === 'percentage-picker';
}

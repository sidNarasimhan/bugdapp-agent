/**
 * KG v2 Validator — enforces the assertion-completeness rules from the
 * design brief. A graph that passes this validator should produce real tests
 * (not clickthrough scripts) when consumed by spec-gen.
 *
 * Rules (per brief):
 *   E1 Every Action has ≥1 REQUIRES_STATE              [error]
 *   E2 Every Action has ≥1 TRANSITIONS_TO              [error]
 *   W1 Action has 0 FAILS_TO                            [warn — flagged hot-spot]
 *   E3 State has 0 incoming TRANSITIONS_TO/FAILS_TO    [error unless isInitial]
 *   E4 Flow's startStateId / endStateId not in graph    [error]
 *   E5 Flow's start → end not reachable via behavioural [error]
 *   W2 ApiCall lacks responseSchema                     [warn]
 *   W3 ContractCall has no expectedEventIds             [warn]
 *   W4 Action lacks PERFORMED_VIA (no UI binding)       [warn]
 *
 * Output: per-flow + global ValidationReport written to <outputDir>/
 * kg-validation.json + console summary.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentStateType } from '../agent/state.js';
import { KGv2Builder, type ActionNode, type StateNode, type FlowNode, type ApiCallNode, type ContractCallNode } from '../agent/kg-v2.js';
import { loadKGv2 } from './kg-migrate.js';

export type Severity = 'error' | 'warn';
export interface ValidationIssue {
  rule: string;
  severity: Severity;
  nodeId?: string;
  flowId?: string;
  message: string;
}

export interface ValidationReport {
  generatedAt: string;
  passed: boolean;
  counts: { errors: number; warnings: number; total: number };
  global: ValidationIssue[];
  perFlow: { flowId: string; flowLabel: string; issues: ValidationIssue[] }[];
}

/** Bipartite reachability over the state⇄action graph.
 *  From a State: hop to Actions that REQUIRES this state (incoming
 *  REQUIRES_STATE), then from each Action follow outgoing TRANSITIONS_TO /
 *  FAILS_TO to next States.
 *  From an Action: follow outgoing TRANSITIONS_TO / FAILS_TO to States. */
function reachable(b: KGv2Builder, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    const node = b.nodes.get(cur);
    if (!node) continue;
    const next: string[] = [];
    if (node.kind === 'state') {
      for (const e of b.incoming(cur, 'REQUIRES_STATE')) next.push(e.from);
    } else if (node.kind === 'action') {
      for (const e of b.outgoing(cur, 'TRANSITIONS_TO')) next.push(e.to);
      for (const e of b.outgoing(cur, 'FAILS_TO')) next.push(e.to);
    }
    for (const n of next) {
      if (n === to) return true;
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  return false;
}

export function validateKGv2(b: KGv2Builder): ValidationReport {
  const global: ValidationIssue[] = [];
  const perFlowMap = new Map<string, ValidationIssue[]>();
  const flows = b.byKind('flow') as FlowNode[];
  for (const f of flows) perFlowMap.set(f.id, []);

  // Index actions by flow membership via INCLUDES_ACTION.
  const flowOf = new Map<string, string>();  // actionId → flowId
  for (const f of flows) {
    for (const e of b.outgoing(f.id, 'INCLUDES_ACTION')) flowOf.set(e.to, f.id);
  }
  const pushIssue = (issue: ValidationIssue) => {
    if (issue.flowId && perFlowMap.has(issue.flowId)) perFlowMap.get(issue.flowId)!.push(issue);
    else global.push(issue);
  };

  // E1, E2, W1, W4 — Action checks.
  const actions = b.byKind('action') as ActionNode[];
  for (const a of actions) {
    const fid = flowOf.get(a.id);
    const reqState = b.outgoing(a.id, 'REQUIRES_STATE').length;
    const transTo  = b.outgoing(a.id, 'TRANSITIONS_TO').length;
    const failsTo  = b.outgoing(a.id, 'FAILS_TO').length;
    const performedVia = b.outgoing(a.id, 'PERFORMED_VIA').length;
    if (reqState === 0)  pushIssue({ rule: 'E1', severity: 'error', nodeId: a.id, flowId: fid, message: `Action "${a.label}" has no REQUIRES_STATE — preconditions undefined` });
    if (transTo === 0)   pushIssue({ rule: 'E2', severity: 'error', nodeId: a.id, flowId: fid, message: `Action "${a.label}" has no TRANSITIONS_TO — success outcome undefined` });
    if (failsTo === 0)   pushIssue({ rule: 'W1', severity: 'warn',  nodeId: a.id, flowId: fid, message: `Action "${a.label}" has no FAILS_TO — no failure-mode coverage = clickthrough not test` });
    if (performedVia === 0) pushIssue({ rule: 'W4', severity: 'warn', nodeId: a.id, flowId: fid, message: `Action "${a.label}" has no PERFORMED_VIA — UI binding missing, spec-gen can't emit selector` });
  }

  // E3 — State entry checks.
  const states = b.byKind('state') as StateNode[];
  for (const s of states) {
    if (s.isInitial) continue;
    const incoming = b.incoming(s.id).filter(e => e.edgeType === 'TRANSITIONS_TO' || e.edgeType === 'FAILS_TO');
    if (incoming.length === 0) {
      // Flow START_STATE pointers also count as "entry".
      const isFlowStart = b.incoming(s.id, 'START_STATE').length > 0;
      if (!isFlowStart) pushIssue({ rule: 'E3', severity: 'error', nodeId: s.id, message: `State "${s.label}" has no entry transition and is not initial / flow-start — orphan` });
    }
  }

  // E4, E5 — Flow checks.
  for (const f of flows) {
    const start = b.nodes.get(f.startStateId);
    const end = b.nodes.get(f.endStateId);
    if (!start || start.kind !== 'state') pushIssue({ rule: 'E4', severity: 'error', nodeId: f.id, flowId: f.id, message: `Flow "${f.label}" startStateId ${f.startStateId} not a state node` });
    if (!end   || end.kind   !== 'state') pushIssue({ rule: 'E4', severity: 'error', nodeId: f.id, flowId: f.id, message: `Flow "${f.label}" endStateId ${f.endStateId} not a state node` });
    if (start && end && !reachable(b, f.startStateId, f.endStateId)) {
      pushIssue({ rule: 'E5', severity: 'error', nodeId: f.id, flowId: f.id, message: `Flow "${f.label}" — end state not reachable from start state via behavioral edges` });
    }
  }

  // W2, W3 — Technical layer checks.
  for (const a of b.byKind('apiCall') as ApiCallNode[]) {
    if (!a.responseSchema) global.push({ rule: 'W2', severity: 'warn', nodeId: a.id, message: `ApiCall ${a.method} ${a.urlPattern} has no responseSchema — assertion target missing` });
  }
  for (const c of b.byKind('contractCall') as ContractCallNode[]) {
    if (c.expectedEventIds.length === 0) global.push({ rule: 'W3', severity: 'warn', nodeId: c.id, message: `ContractCall ${c.contractAddress} ${c.functionSignature} has no expectedEventIds — receipt assertion impossible` });
  }

  // Tally.
  let errors = 0, warnings = 0;
  const allIssues = [...global, ...flows.flatMap(f => perFlowMap.get(f.id) ?? [])];
  for (const i of allIssues) (i.severity === 'error' ? (errors++) : (warnings++));

  return {
    generatedAt: new Date().toISOString(),
    passed: errors === 0,
    counts: { errors, warnings, total: allIssues.length },
    global,
    perFlow: flows.map(f => ({ flowId: f.id, flowLabel: f.label, issues: perFlowMap.get(f.id) ?? [] })),
  };
}

export function createKGValidatorNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType> & { kgValidation?: ValidationReport }> => {
    const b = loadKGv2(state.config.outputDir);
    if (!b) {
      console.log('[kg-validator] no kg-v2.json — skipping');
      return {};
    }
    console.log('━━━ KG Validator ━━━');
    const report = validateKGv2(b);
    const reportPath = join(state.config.outputDir, 'kg-validation.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // Console summary.
    console.log(`[kg-validator] ${report.counts.errors} errors · ${report.counts.warnings} warnings · ${report.passed ? 'PASS' : 'FAIL'}`);
    // Group rule frequencies.
    const ruleCounts = new Map<string, number>();
    const allIssues = [...report.global, ...report.perFlow.flatMap(p => p.issues)];
    for (const i of allIssues) ruleCounts.set(i.rule, (ruleCounts.get(i.rule) ?? 0) + 1);
    for (const [rule, count] of [...ruleCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${rule}: ${count}`);
    }
    // Show first few errors verbatim.
    const firstErrs = allIssues.filter(i => i.severity === 'error').slice(0, 5);
    for (const e of firstErrs) console.log(`  [error] ${e.rule}: ${e.message}`);
    if (allIssues.filter(i => i.severity === 'error').length > 5) {
      console.log(`  ... + ${allIssues.filter(i => i.severity === 'error').length - 5} more errors in kg-validation.json`);
    }

    return { kgValidation: report };
  };
}

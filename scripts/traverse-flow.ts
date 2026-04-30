#!/usr/bin/env npx tsx
/**
 * Traverse a v2 flow → narrate the user journey it represents.
 *
 * For each Flow (or one named via --flow <substr>):
 *   walk startState → REQUIRES_STATE-back to actions → TRANSITIONS_TO → next state
 *   narrate each step + show preconditions + show failure modes branching off
 *   resolve PERFORMED_VIA to the bound component (selector / label)
 *   resolve TRIGGERS_API_CALL + INVOKES_CONTRACT_CALL + EMITS_EVENT to assertion targets
 *
 * This proves the schema serves the agent's business logic — not just stores data.
 *
 *   npx tsx scripts/traverse-flow.ts --dir output/developer-avantisfi-com
 *   npx tsx scripts/traverse-flow.ts --flow "Open Fixed-Fee Market Long" --dir output/...
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { KGv2Builder, type FlowNode, type StateNode, type ActionNode, type StructuralNode, type ApiCallNode, type ContractCallNode, type EventNode } from '../src/agent/kg-v2.js';

function argVal(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const outputDir = argVal('--dir', join(process.cwd(), 'output', 'developer-avantisfi-com'));
const flowFilter = argVal('--flow', '');
const limit = Number(argVal('--limit', '3'));

const kg = JSON.parse(readFileSync(join(outputDir, 'kg-v2.json'), 'utf-8'));
const b = KGv2Builder.load(kg);

const flows = (b.byKind('flow') as FlowNode[]).filter(f => !flowFilter || f.label.toLowerCase().includes(flowFilter.toLowerCase()));
const targets = flows.slice(0, limit);

console.log(`━━━ Traversing ${targets.length} flow(s) of ${flows.length} matching ━━━\n`);

let totalAssertableSteps = 0;
let totalSteps = 0;
let totalFailureModes = 0;

for (const flow of targets) {
  console.log(`▼ FLOW: ${flow.label}`);
  console.log(`  archetype: ${flow.archetype ?? '(none)'} · provenance: ${flow.provenance}${flow.inferenceSource ? ` (${flow.inferenceSource})` : ''}`);
  console.log(`  intent: ${flow.description}`);

  const start = b.nodes.get(flow.startStateId) as StateNode | undefined;
  const end = b.nodes.get(flow.endStateId) as StateNode | undefined;
  console.log(`  START: ${start?.label ?? '(missing)'}`);
  if (start?.conditions?.notes) console.log(`         conditions: ${start.conditions.notes.slice(0, 120)}`);
  console.log(`  END:   ${end?.label ?? '(missing)'}`);
  if (end?.conditions?.notes) console.log(`         conditions: ${end.conditions.notes.slice(0, 120)}`);
  console.log(`  steps: ${flow.actionIds.length}`);
  console.log('');

  let currentState = start?.id ?? '';
  for (let i = 0; i < flow.actionIds.length; i++) {
    const action = b.nodes.get(flow.actionIds[i]) as ActionNode | undefined;
    if (!action) continue;
    totalSteps++;

    const reqStates = b.outgoing(action.id, 'REQUIRES_STATE').map(e => b.nodes.get(e.to) as StateNode).filter(Boolean);
    const transTo = b.outgoing(action.id, 'TRANSITIONS_TO').map(e => b.nodes.get(e.to) as StateNode).filter(Boolean);
    const failsTo = b.outgoing(action.id, 'FAILS_TO').map(e => ({ state: b.nodes.get(e.to) as StateNode, label: e.label })).filter(x => x.state);
    const performedVia = b.outgoing(action.id, 'PERFORMED_VIA').map(e => b.nodes.get(e.to) as StructuralNode).filter(Boolean);
    const apiCalls = b.outgoing(action.id, 'TRIGGERS_API_CALL').map(e => b.nodes.get(e.to) as ApiCallNode).filter(Boolean);
    const contractCalls = b.outgoing(action.id, 'INVOKES_CONTRACT_CALL').map(e => b.nodes.get(e.to) as ContractCallNode).filter(Boolean);

    if (failsTo.length > 0) totalFailureModes += failsTo.length;
    if (performedVia.length > 0 || apiCalls.length > 0 || contractCalls.length > 0) totalAssertableSteps++;

    console.log(`  [${i + 1}] ACTION: ${action.label}  (${action.actionType}${action.inputValue !== undefined ? `, value=${action.inputValue}` : ''})`);
    if (reqStates.length) console.log(`        precondition: ${reqStates.map(s => s.label).join(', ').slice(0, 100)}`);
    if (performedVia.length) console.log(`        via UI: ${performedVia.slice(0, 2).map(c => `${c.label} [${c.selector ?? c.kind}]`).join(' | ').slice(0, 120)}`);
    if (apiCalls.length) console.log(`        triggers API: ${apiCalls.slice(0, 3).map(a => `${a.method} ${a.urlPattern}`).join(', ')}`);
    if (contractCalls.length) {
      const cc = contractCalls[0];
      const events = cc.expectedEventIds.slice(0, 2).map(eid => (b.nodes.get(eid) as EventNode)?.signature).filter(Boolean);
      console.log(`        invokes contract: ${cc.contractAddress.slice(0, 10)}… ${cc.functionSignature}`);
      if (events.length) console.log(`          expected events: ${events.join(' · ')}`);
    }
    if (transTo.length) console.log(`        ✓ success → ${transTo.map(s => s.label).join(', ').slice(0, 100)}`);
    for (const f of failsTo.slice(0, 4)) {
      console.log(`        ✗ failure → ${f.state.label}  ${f.label ? `(${f.label})` : ''}`);
    }
    console.log('');
  }
  console.log('');
}

console.log(`━━━ Audit ━━━`);
console.log(`flows traversed:           ${targets.length}`);
console.log(`total action steps:        ${totalSteps}`);
console.log(`steps with assertion data: ${totalAssertableSteps}  (PERFORMED_VIA or API/contract bound)`);
console.log(`failure modes catalogued:  ${totalFailureModes}`);
console.log(`assertion coverage:        ${totalSteps ? Math.round(100 * totalAssertableSteps / totalSteps) : 0}%`);

// Cross-check: do flows match v1 capabilities?
const capPath = join(outputDir, 'capabilities.json');
try {
  const caps = JSON.parse(readFileSync(capPath, 'utf-8'));
  const matched = targets.filter(f => caps.some((c: any) => c.id === f.legacyCapabilityId));
  console.log(`flows linked to v1 caps:   ${matched.length}/${targets.length}  (legacyCapabilityId integrity)`);
} catch {
  console.log(`flows linked to v1 caps:   (capabilities.json not found)`);
}

#!/usr/bin/env npx tsx
/**
 * find-flow — natural-language → KG flow lookup → executable step list.
 *
 * The agent's core test:  "go long on BTC"  →  pick the matching Flow  →
 * traverse its actions  →  emit the steps an executor needs to follow,
 * complete with UI selectors + assertion targets.
 *
 *   npx tsx scripts/find-flow.ts "go long on BTC"
 *   npx tsx scripts/find-flow.ts "deposit USDC as collateral"
 *   npx tsx scripts/find-flow.ts "max leverage short ETH" --topk 3
 *
 * If the schema is doing its job, the right flow comes back, and every step
 * carries a UI selector and / or a tx assertion target. If not, we get
 * nothing usable — which is the failure mode that proves the KG isn't ready.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { KGv2Builder, type FlowNode, type ActionNode, type StateNode, type StructuralNode, type ApiCallNode, type ContractCallNode, type EventNode } from '../src/agent/kg-v2.js';

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const positional = process.argv.slice(2).filter(a => !a.startsWith('--') && process.argv[process.argv.indexOf(a) - 1]?.startsWith('--') === false);
const query = positional.join(' ').trim();
const outputDir = arg('dir', join(process.cwd(), 'output', 'developer-avantisfi-com'))!;
const topK = Number(arg('topk', '1'));

if (!query) {
  console.error('Usage: find-flow "<natural language query>" [--dir <output dir>] [--topk N]');
  process.exit(2);
}

const kg = JSON.parse(readFileSync(join(outputDir, 'kg-v2.json'), 'utf-8'));
const b = KGv2Builder.load(kg);
const flows = b.byKind('flow') as FlowNode[];

// ── Score each flow against the query ─────────────────────────────────────

const STOP = new Set(['the','a','an','and','or','of','on','for','to','with','this','that','at','in','make','get','do','please']);
const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !STOP.has(t));

// Asset symbol normalization — "btc" matches "BTCUSD", "BTC-USD", "btcusd" etc.
function assetMatches(token: string, value: string): boolean {
  const v = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return v.includes(token) && token.length >= 2;
}

interface Scored { flow: FlowNode; score: number; reasons: string[] }
const scored: Scored[] = [];
for (const flow of flows) {
  let score = 0;
  const reasons: string[] = [];
  const label = flow.label.toLowerCase();
  const desc = (flow.description || '').toLowerCase();

  for (const t of tokens) {
    if (label.includes(t))   { score += 5; reasons.push(`label~"${t}"`); }
    if (desc.includes(t))    { score += 2; reasons.push(`desc~"${t}"`); }
    if (flow.archetype?.toLowerCase() === t)  { score += 4; reasons.push(`archetype=${t}`); }
  }

  // Look at the flow's actions' inputValues for matches like "Long", "Short",
  // "Market", "10%", asset symbol, etc.
  const actions = flow.actionIds.map(aid => b.nodes.get(aid)).filter(n => n?.kind === 'action') as ActionNode[];
  for (const a of actions) {
    const av = (a.inputValue ?? '').toLowerCase();
    const al = a.label.toLowerCase();
    for (const t of tokens) {
      if (av && av.includes(t)) { score += 3; reasons.push(`step "${a.label}" value~"${t}"`); }
      if (assetMatches(t, av))  { score += 2; reasons.push(`asset "${a.inputValue}"~"${t}"`); }
      if (al.includes(t))       { score += 1; reasons.push(`step "${a.label}"~"${t}"`); }
    }
  }
  if (score > 0) scored.push({ flow, score, reasons });
}

scored.sort((a, b) => b.score - a.score);
const matches = scored.slice(0, topK);

if (matches.length === 0) {
  console.log(`No flow matched "${query}". Tokens parsed: [${tokens.join(', ')}]`);
  console.log('Available flows:');
  for (const f of flows.slice(0, 10)) console.log(`  - ${f.label}`);
  process.exit(1);
}

// ── Render each match as an executable step list ──────────────────────────

for (let mi = 0; mi < matches.length; mi++) {
  const { flow, score, reasons } = matches[mi];
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`MATCH ${mi + 1}/${matches.length}: ${flow.label}  (score=${score})`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`Intent:    ${flow.description}`);
  console.log(`Archetype: ${flow.archetype ?? '(none)'}`);
  console.log(`Why matched: ${[...new Set(reasons)].slice(0, 6).join(', ')}`);

  const start = b.nodes.get(flow.startStateId) as StateNode | undefined;
  const end = b.nodes.get(flow.endStateId) as StateNode | undefined;
  console.log(`\nSTART STATE: ${start?.label ?? '(missing)'}`);
  if (start?.conditions?.notes) console.log(`             ${start.conditions.notes.slice(0, 200)}`);
  console.log(`END STATE:   ${end?.label ?? '(missing)'}`);
  if (end?.conditions?.notes)   console.log(`             ${end.conditions.notes.slice(0, 200)}`);

  console.log(`\n──── STEPS (${flow.actionIds.length}) ────────────────────────────────────────`);
  let allHaveSelector = true;
  for (let i = 0; i < flow.actionIds.length; i++) {
    const action = b.nodes.get(flow.actionIds[i]) as ActionNode | undefined;
    if (!action) continue;
    const performedVia = b.outgoing(action.id, 'PERFORMED_VIA').map(e => b.nodes.get(e.to) as StructuralNode).filter(Boolean);
    const apiCalls = b.outgoing(action.id, 'TRIGGERS_API_CALL').map(e => b.nodes.get(e.to) as ApiCallNode).filter(Boolean);
    const contractCalls = b.outgoing(action.id, 'INVOKES_CONTRACT_CALL').map(e => b.nodes.get(e.to) as ContractCallNode).filter(Boolean);
    const failsTo = b.outgoing(action.id, 'FAILS_TO').map(e => ({ s: b.nodes.get(e.to) as StateNode, label: e.label })).filter(x => x.s);
    if (performedVia.length === 0) allHaveSelector = false;

    const valSuffix = action.inputValue !== undefined ? ` (${action.inputValue})` : '';
    console.log(`\n  ${i + 1}. ${action.label}${valSuffix}  [${action.actionType}]`);
    if (performedVia.length) {
      const c = performedVia[0];
      console.log(`     UI:        ${c.selector ?? c.label}`);
    } else {
      console.log(`     UI:        ⚠ no PERFORMED_VIA — selector unknown`);
    }
    if (apiCalls.length) {
      console.log(`     API:       ${apiCalls.slice(0, 2).map(a => `${a.method} ${a.urlPattern}`).join(' · ')}${apiCalls.length > 2 ? ` (+${apiCalls.length - 2} more)` : ''}`);
    }
    if (contractCalls.length) {
      const cc = contractCalls[0];
      console.log(`     Contract:  ${cc.contractAddress.slice(0, 10)}…  ${cc.functionSignature}`);
      const events = cc.expectedEventIds.map(eid => (b.nodes.get(eid) as EventNode)?.signature).filter(Boolean).slice(0, 2);
      if (events.length) console.log(`     Assert:    expect events  ${events.join(' · ')}`);
    }
    if (failsTo.length) {
      console.log(`     Failures:  ${failsTo.slice(0, 4).map(f => f.s.label).join(' | ')}`);
    }
  }

  // Verdict
  console.log(`\n──── VERDICT ───────────────────────────────────────────────────`);
  console.log(`  steps: ${flow.actionIds.length}`);
  console.log(`  every step bound to UI selector: ${allHaveSelector ? '✓ yes' : '✗ NO — agent cannot execute this flow blindly'}`);
  const failureCount = flow.actionIds.reduce((n, aid) => n + b.outgoing(aid, 'FAILS_TO').length, 0);
  console.log(`  failure modes catalogued:        ${failureCount}`);
  const txStep = flow.actionIds.find(aid => {
    const a = b.nodes.get(aid) as ActionNode;
    return a?.actionType === 'wallet-sign' && b.outgoing(aid, 'INVOKES_CONTRACT_CALL').length > 0;
  });
  console.log(`  on-chain assertion target:       ${txStep ? '✓ yes (wallet-sign step has contract + events bound)' : '✗ no'}`);
  console.log(`  business-logic check:            ${allHaveSelector && txStep ? '✓ executable + verifiable' : '✗ partial — needs cleanup'}`);
}

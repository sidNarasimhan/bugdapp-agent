#!/usr/bin/env npx tsx
/**
 * probe-brain — runs the questions an autonomous QA agent would actually ask
 * the KG, and reports pass/fail per probe. The tally tells you whether v2
 * is ready to be the agent's only knowledge source.
 *
 * Probes cover the agent's full reasoning loop:
 *   1. INTENT → FLOW    : "go long on BTC" → which flow runs this?
 *   2. STEP EXECUTION   : for each step, do I have a UI selector to click?
 *   3. ASSERTION TARGET : is there an on-chain or API target to verify?
 *   4. NEGATIVE TEST    : what failure modes can I exercise?
 *   5. WHY              : where in the docs is this behavior described?
 *   6. CONSTRAINTS      : what's the max/min for this input?
 *   7. ASSET METADATA   : what are valid trading assets / their leverage?
 *   8. FEATURE QUERY    : does this dApp support feature X?
 *   9. PAGE TOPOLOGY    : what flows live on /trade?
 *  10. CONTRACT MAP     : which addresses do I monitor for tx receipts?
 *
 *   npx tsx scripts/probe-brain.ts [--dir output/<dapp>]
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { KGv2Builder, type FlowNode, type ActionNode, type StateNode, type StructuralNode, type ApiCallNode, type ContractCallNode, type EventNode, type DocSectionNode, type ConstraintNode, type AssetNode, type FeatureNode } from '../src/agent/kg-v2.js';

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const outputDir = arg('dir', join(process.cwd(), 'output', 'developer-avantisfi-com'))!;
const kg = JSON.parse(readFileSync(join(outputDir, 'kg-v2.json'), 'utf-8'));
const b = KGv2Builder.load(kg);

let pass = 0, fail = 0;
const results: { probe: string; ok: boolean; detail: string }[] = [];
function probe(name: string, fn: () => { ok: boolean; detail: string }) {
  try {
    const r = fn();
    results.push({ probe: name, ok: r.ok, detail: r.detail });
    r.ok ? pass++ : fail++;
  } catch (e: any) {
    results.push({ probe: name, ok: false, detail: `error: ${e?.message}` });
    fail++;
  }
}

const flows = b.byKind('flow') as FlowNode[];

// 1. INTENT → FLOW
probe('intent→flow: "go long on BTC"', () => {
  const STOP = new Set(['the','a','on','for','to','with','go']);
  const tokens = 'go long on BTC'.toLowerCase().split(/\W+/).filter(t => t && !STOP.has(t));
  const scored = flows.map(f => {
    let s = 0;
    const text = (f.label + ' ' + f.description).toLowerCase();
    for (const t of tokens) if (text.includes(t)) s += 5;
    for (const aid of f.actionIds) {
      const a = b.nodes.get(aid) as ActionNode;
      if (!a) continue;
      const av = (a.inputValue ?? '').toLowerCase();
      for (const t of tokens) if (av.includes(t)) s += 3;
    }
    return { f, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  if (scored.length === 0) return { ok: false, detail: 'no flow matched' };
  return { ok: true, detail: `top match: "${scored[0].f.label}" (score ${scored[0].s})` };
});

// 2. STEP EXECUTION — every step has a UI selector
probe('step execution: every action has PERFORMED_VIA selector', () => {
  const actions = b.byKind('action') as ActionNode[];
  const withVia = actions.filter(a => b.outgoing(a.id, 'PERFORMED_VIA').length > 0);
  const pct = Math.round(100 * withVia.length / actions.length);
  return { ok: pct >= 90, detail: `${withVia.length}/${actions.length} = ${pct}%` };
});

// 3. ASSERTION TARGET — every wallet-sign action has a contract + events bound
probe('assertion target: wallet-sign actions have contract + event', () => {
  const wsigns = (b.byKind('action') as ActionNode[]).filter(a => a.actionType === 'wallet-sign');
  const withTx = wsigns.filter(a => {
    const cc = b.outgoing(a.id, 'INVOKES_CONTRACT_CALL').map(e => b.nodes.get(e.to) as ContractCallNode).find(Boolean);
    return cc && cc.expectedEventIds.length > 0;
  });
  const pct = wsigns.length ? Math.round(100 * withTx.length / wsigns.length) : 0;
  return { ok: pct >= 80, detail: `${withTx.length}/${wsigns.length} wallet-sign actions = ${pct}%` };
});

// 4. NEGATIVE TEST — every flow has at least one FAILS_TO catalogued
probe('negative test: every flow has ≥1 failure mode', () => {
  const flowsWithFails = flows.filter(f => f.actionIds.some(aid => b.outgoing(aid, 'FAILS_TO').length > 0));
  const pct = Math.round(100 * flowsWithFails.length / flows.length);
  return { ok: pct >= 90, detail: `${flowsWithFails.length}/${flows.length} flows = ${pct}%` };
});

// 5. WHY — flow can cite its docs
probe('why: flows have DESCRIBED_BY → docSection', () => {
  const docs = b.byKind('docSection');
  if (docs.length === 0) return { ok: false, detail: 'no docSection nodes in graph' };
  const flowsWithDocs = flows.filter(f => b.outgoing(f.id, 'DESCRIBED_BY').length > 0);
  const pct = Math.round(100 * flowsWithDocs.length / flows.length);
  return { ok: pct >= 50, detail: `${docs.length} doc nodes; ${flowsWithDocs.length}/${flows.length} flows linked = ${pct}%` };
});

// 6. CONSTRAINTS — max/min boundaries are first-class
probe('constraints: first-class with values + edges', () => {
  const cons = b.byKind('constraint') as ConstraintNode[];
  if (cons.length === 0) return { ok: false, detail: 'no constraint nodes' };
  const linked = cons.filter(c => b.outgoing(c.id, 'CONSTRAINS').length > 0);
  return { ok: linked.length >= 1, detail: `${cons.length} constraints (${linked.length} linked via CONSTRAINS): ${cons.slice(0, 3).map(c => `${c.label}=${c.value}`).join(', ')}` };
});

// 7. ASSET METADATA — agent can list trading assets
probe('asset metadata: list assets + asset class', () => {
  const assets = b.byKind('asset') as AssetNode[];
  if (assets.length === 0) return { ok: false, detail: 'no asset nodes' };
  const classes = new Set(assets.map(a => a.assetClass).filter(Boolean));
  return { ok: assets.length >= 5, detail: `${assets.length} assets across ${classes.size} classes: ${[...classes].join(', ')}` };
});

// 8. FEATURE QUERY — agent can verify whether dApp has feature X
probe('feature query: feature nodes exist', () => {
  const feats = b.byKind('feature') as FeatureNode[];
  if (feats.length === 0) return { ok: false, detail: 'no feature nodes' };
  return { ok: true, detail: `${feats.length} features: ${feats.slice(0, 3).map(f => f.name).join(', ')}` };
});

// 9. PAGE TOPOLOGY — agent can list flows per page
probe('page topology: flows resolvable per page via component → action → flow', () => {
  const pages = b.byKind('page') as StructuralNode[];
  let totalLinks = 0;
  for (const p of pages) {
    const components = b.outgoing(p.id, 'CONTAINS').map(e => e.to);
    const flowsHere = new Set<string>();
    for (const cid of components) {
      // component <-PERFORMED_VIA- action -INCLUDES_ACTION (incoming)- flow
      for (const e of b.incoming(cid, 'PERFORMED_VIA')) {
        for (const fe of b.incoming(e.from, 'INCLUDES_ACTION')) flowsHere.add(fe.from);
      }
    }
    totalLinks += flowsHere.size;
  }
  return { ok: totalLinks > 0, detail: `${pages.length} pages, ${totalLinks} (page → flow) resolutions across all pages` };
});

// 10. CONTRACT MAP — agent has a list of addresses to watch
probe('contract map: deduped contract addresses', () => {
  const ccs = b.byKind('contractCall') as ContractCallNode[];
  const addrs = new Set(ccs.map(c => c.contractAddress));
  return { ok: addrs.size > 0, detail: `${addrs.size} unique addresses, ${ccs.filter(c => c.expectedEventIds.length > 0).length} with bound events` };
});

// ── Print report ─────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════════');
console.log(`AGENT BRAIN PROBE — ${kg.dappUrl}`);
console.log(`KG: ${kg.nodes.length} nodes · ${kg.edges.length} edges · crawl ${kg.crawlId}`);
console.log('══════════════════════════════════════════════════════════════════\n');

for (const r of results) {
  const tick = r.ok ? '✓' : '✗';
  console.log(`  ${tick}  ${r.probe.padEnd(58)}  ${r.detail}`);
}

console.log('\n──────────────────────────────────────────────────────────────────');
console.log(`SCORE: ${pass}/${results.length} probes passed (${Math.round(100 * pass / results.length)}%)`);
console.log('──────────────────────────────────────────────────────────────────\n');

if (fail > 0) {
  console.log('Failed probes are real gaps the agent will hit at execution time.');
  process.exit(1);
}

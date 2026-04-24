#!/usr/bin/env npx tsx
/**
 * KG visualizer — reads modules.json + knowledge-graph.json + module-edges.json
 * + flows-by-persona.json, emits a single self-contained HTML using vis-network
 * (CDN). Open in a browser, zoom/pan, click nodes for details.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const outputDir = join(process.cwd(), 'output', 'developer-avantisfi-com');
const kg = JSON.parse(readFileSync(join(outputDir, 'knowledge-graph.json'), 'utf-8'));
const modules = JSON.parse(readFileSync(join(outputDir, 'modules.json'), 'utf-8'));
const edges = existsSync(join(outputDir, 'module-edges.json'))
  ? JSON.parse(readFileSync(join(outputDir, 'module-edges.json'), 'utf-8'))
  : [];
const flows = existsSync(join(outputDir, 'flows-by-persona.json'))
  ? JSON.parse(readFileSync(join(outputDir, 'flows-by-persona.json'), 'utf-8'))
  : [];

type Mod = { id: string; name: string; parentId?: string; archetype?: string; pageIds: string[]; componentIds: string[]; docSectionIds: string[]; contractAddresses: string[]; triggeredByComponentIds: string[]; description?: string; businessPurpose?: string; subModules?: Mod[] };
function flatMods(ms: Mod[]): Mod[] { const o: Mod[] = []; const w = (xs: Mod[]) => xs.forEach(x => { o.push(x); if (x.subModules?.length) w(x.subModules); }); w(ms); return o; }

const allMods = flatMods(modules);

// Build nodes
const nodes: any[] = [];
const nodeSet = new Set<string>();
const add = (n: any) => { if (!nodeSet.has(n.id)) { nodeSet.add(n.id); nodes.push(n); } };

const archColor: Record<string, string> = {
  perps: '#ff6b6b', swap: '#4ecdc4', lending: '#ffa94d', staking: '#c77dff',
  yield: '#06d6a0', cdp: '#118ab2', bridge: '#ee6c4d', general: '#adb5bd',
};

// Pages (top row)
for (const p of kg.pages) {
  add({
    id: p.id, label: p.name, group: 'page', shape: 'box',
    color: { background: '#e7f5ff', border: '#1c7ed6' },
    font: { size: 16 },
    title: `Page: ${p.name}\nURL: ${p.url}\nElements: ${p.elementCount}`,
  });
}

// Modules
for (const m of allMods) {
  const color = archColor[m.archetype ?? 'general'] ?? '#adb5bd';
  add({
    id: m.id,
    label: m.name,
    group: 'module',
    shape: m.parentId ? 'ellipse' : 'hexagon',
    color: { background: color, border: '#222' },
    font: { color: '#fff', size: m.parentId ? 14 : 18, bold: !m.parentId },
    size: m.parentId ? 20 : 30,
    title: `Module: ${m.name}\nArchetype: ${m.archetype}\nComponents: ${m.componentIds.length}\nDocs: ${m.docSectionIds.length}\n${m.businessPurpose ?? ''}`,
  });
}

// Components (named only, de-duped by assignment to the FIRST module that contains them)
const compOwner = new Map<string, string>(); // componentId → moduleId (first wins)
for (const m of allMods) {
  for (const cid of m.componentIds) {
    if (!compOwner.has(cid)) compOwner.set(cid, m.id);
  }
}
for (const c of kg.components) {
  if (!c.name || c.disabled) continue;
  const ownerId = compOwner.get(c.id);
  if (!ownerId) continue; // skip orphans
  add({
    id: c.id,
    label: c.name.slice(0, 24),
    group: 'component',
    shape: 'dot',
    size: 8,
    color: { background: '#495057', border: '#495057' },
    font: { size: 10, color: '#333' },
    title: `${c.role}: "${c.name}"\nPage: ${c.pageId ?? '?'}\nid: ${c.id}`,
  });
}

// Docs
for (let i = 0; i < (kg.docSections ?? []).length; i++) {
  const d = kg.docSections[i];
  const id = d.id ?? `doc:${i}`;
  // Only add if some module references it
  const referenced = allMods.some(m => m.docSectionIds.includes(id));
  if (!referenced) continue;
  add({
    id,
    label: (d.title ?? '(untitled)').slice(0, 24),
    group: 'doc',
    shape: 'triangle',
    size: 10,
    color: { background: '#ffd43b', border: '#f59f00' },
    font: { size: 10 },
    title: `Doc: ${d.title}\n${(d.content ?? '').slice(0, 200)}`,
  });
}

// Edges
const vedges: any[] = [];

// page → module (hosts)
for (const m of allMods) {
  for (const pid of m.pageIds) {
    if (nodeSet.has(pid)) vedges.push({ from: pid, to: m.id, color: { color: '#1c7ed6' }, label: 'hosts', font: { size: 10, color: '#1c7ed6' } });
  }
}

// module → sub-module (has_sub_module)
for (const m of allMods) {
  if (m.parentId && nodeSet.has(m.parentId)) {
    vedges.push({ from: m.parentId, to: m.id, color: { color: '#845ef7' }, width: 2, label: 'sub', font: { size: 10 } });
  }
}

// module → component (has_component) — only to the owning module
for (const [cid, mid] of compOwner) {
  vedges.push({ from: mid, to: cid, color: { color: '#adb5bd' }, dashes: [3, 3], arrows: { to: { enabled: false } } });
}

// component → module (triggered_by / reveals)
for (const m of allMods) {
  for (const cid of m.triggeredByComponentIds) {
    if (nodeSet.has(cid)) vedges.push({ from: cid, to: m.id, color: { color: '#51cf66' }, width: 2, label: 'reveals', font: { size: 10, color: '#2b8a3e' } });
  }
}

// module → doc (explained_by)
for (const m of allMods) {
  for (const did of m.docSectionIds) {
    if (nodeSet.has(did)) vedges.push({ from: m.id, to: did, color: { color: '#f59f00' }, dashes: [5, 5], label: 'explains', font: { size: 10, color: '#f59f00' } });
  }
}

// component → component (leads_to_next, interacts_with — from module-edges)
for (const e of edges) {
  if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
  if (e.type === 'leads_to_next') {
    vedges.push({ from: e.from, to: e.to, color: { color: '#e67700' }, arrows: 'to', label: 'next', font: { size: 9, color: '#e67700' } });
  } else if (e.type === 'interacts_with') {
    vedges.push({ from: e.from, to: e.to, color: { color: '#d6336c' }, dashes: true, arrows: { to: false, from: false } });
  }
}

const stats = {
  modules: allMods.length,
  components: nodes.filter(n => n.group === 'component').length,
  pages: nodes.filter(n => n.group === 'page').length,
  docs: nodes.filter(n => n.group === 'doc').length,
  edges: vedges.length,
  flows: flows.length,
};

const html = `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Avantis KG — bugdapp-agent</title>
<script src="https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<style>
  body{font-family:ui-monospace,Menlo,monospace;margin:0;background:#1a1b1e;color:#e9ecef}
  #top{padding:12px 16px;border-bottom:1px solid #343a40;background:#25262b;display:flex;gap:24px;flex-wrap:wrap;align-items:center}
  #top h1{margin:0;font-size:16px;font-weight:600}
  .stat{font-size:12px;color:#adb5bd}
  .stat b{color:#fff}
  .legend{display:flex;gap:12px;font-size:11px;align-items:center}
  .legend span{display:inline-flex;align-items:center;gap:4px}
  .sw{width:14px;height:14px;display:inline-block;border:1px solid #444}
  #mynet{width:100vw;height:calc(100vh - 56px)}
  #detail{position:absolute;right:12px;top:72px;width:360px;max-height:70vh;overflow:auto;background:#25262b;border:1px solid #444;padding:12px;font-size:12px;display:none;border-radius:6px}
</style>
</head><body>
<div id="top">
  <h1>Avantis KG</h1>
  <span class="stat">modules: <b>${stats.modules}</b></span>
  <span class="stat">components: <b>${stats.components}</b></span>
  <span class="stat">pages: <b>${stats.pages}</b></span>
  <span class="stat">docs: <b>${stats.docs}</b></span>
  <span class="stat">edges: <b>${stats.edges}</b></span>
  <span class="stat">user flows: <b>${stats.flows}</b></span>
  <div class="legend">
    <span><span class="sw" style="background:#1c7ed6"></span>page</span>
    <span><span class="sw" style="background:#ff6b6b"></span>perps</span>
    <span><span class="sw" style="background:#06d6a0"></span>yield</span>
    <span><span class="sw" style="background:#adb5bd"></span>general</span>
    <span><span class="sw" style="background:#495057;border-radius:50%"></span>component</span>
    <span><span class="sw" style="background:#ffd43b"></span>doc</span>
    <span><span class="sw" style="background:#51cf66"></span>reveals</span>
    <span><span class="sw" style="background:#e67700"></span>leads→next</span>
  </div>
</div>
<div id="mynet"></div>
<div id="detail"></div>
<script>
const nodes = new vis.DataSet(${JSON.stringify(nodes)});
const edges = new vis.DataSet(${JSON.stringify(vedges)});
const net = new vis.Network(document.getElementById('mynet'),{nodes,edges},{
  physics:{enabled:true,stabilization:{iterations:300},barnesHut:{gravitationalConstant:-12000,springLength:120}},
  interaction:{hover:true,tooltipDelay:150,navigationButtons:true,keyboard:true},
  nodes:{borderWidth:1},
  edges:{smooth:{type:'continuous'}},
  groups:{
    module:{font:{color:'#fff'}},
    component:{font:{color:'#adb5bd'}},
  },
});
const det=document.getElementById('detail');
net.on('click', p=>{
  if(p.nodes.length===0){det.style.display='none';return;}
  const n=nodes.get(p.nodes[0]);
  det.innerHTML='<b>'+(n.label||n.id)+'</b><br><small>'+n.id+'</small><pre style="white-space:pre-wrap;margin-top:8px;color:#adb5bd;font-size:11px">'+(n.title||'').replace(/</g,'&lt;')+'</pre>';
  det.style.display='block';
});
</script>
</body></html>`;

const outPath = join(outputDir, 'kg-graph.html');
writeFileSync(outPath, html, 'utf-8');
console.log(`written: ${outPath} (${html.length} bytes)`);
console.log(JSON.stringify(stats, null, 2));

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
  // Solid, high-contrast, paired with white text. Ordered roughly by how
  // important the archetype is in Web3 QA (perps most, bridge least).
  perps:   { bg: '#d6336c', text: '#ffffff', border: '#a61e4d' } as any,
  swap:    { bg: '#1098ad', text: '#ffffff', border: '#0b7285' } as any,
  lending: { bg: '#e8590c', text: '#ffffff', border: '#bc4a04' } as any,
  staking: { bg: '#7048e8', text: '#ffffff', border: '#4c2ebd' } as any,
  yield:   { bg: '#2b8a3e', text: '#ffffff', border: '#1d5f2c' } as any,
  cdp:     { bg: '#1864ab', text: '#ffffff', border: '#0b4884' } as any,
  bridge:  { bg: '#e67700', text: '#ffffff', border: '#a56200' } as any,
  general: { bg: '#495057', text: '#ffffff', border: '#212529' } as any,
} as any;

// Pages (top row)
for (const p of kg.pages) {
  add({
    id: p.id, label: `📄 ${p.name}`, group: 'page', shape: 'box',
    color: { background: '#d0ebff', border: '#1971c2', highlight: { background: '#a5d8ff', border: '#0b4884' } },
    font: { size: 18, color: '#0b4884', face: 'system-ui, sans-serif', bold: true },
    margin: 10,
    title: `Page: ${p.name}\nURL: ${p.url}\nElements: ${p.elementCount}`,
  });
}

// Modules
for (const m of allMods) {
  const arch: any = (archColor as any)[m.archetype ?? 'general'] ?? (archColor as any).general;
  add({
    id: m.id,
    label: m.parentId ? m.name : `◆ ${m.name}`,
    group: 'module',
    shape: m.parentId ? 'ellipse' : 'hexagon',
    color: { background: arch.bg, border: arch.border, highlight: { background: arch.border, border: arch.border } },
    font: { color: arch.text, size: m.parentId ? 16 : 20, face: 'system-ui, sans-serif', bold: true },
    size: m.parentId ? 28 : 42,
    margin: 14,
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
const roleShape: Record<string, string> = {
  button: 'dot', link: 'diamond', textbox: 'database', spinbutton: 'database',
  slider: 'square', switch: 'square', combobox: 'triangle', tab: 'dot', checkbox: 'square',
};
const roleColor: Record<string, { bg: string; border: string }> = {
  button: { bg: '#ffffff', border: '#343a40' },
  link: { bg: '#fff3bf', border: '#f59f00' },
  textbox: { bg: '#d3f9d8', border: '#2f9e44' },
  spinbutton: { bg: '#d3f9d8', border: '#2f9e44' },
  slider: { bg: '#ffe3e3', border: '#c92a2a' },
  switch: { bg: '#d0bfff', border: '#5f3dc4' },
  combobox: { bg: '#ffec99', border: '#f08c00' },
  tab: { bg: '#e7f5ff', border: '#1c7ed6' },
};
for (const c of kg.components) {
  if (!c.name || c.disabled) continue;
  const ownerId = compOwner.get(c.id);
  if (!ownerId) continue; // skip orphans
  const rc = roleColor[c.role] ?? { bg: '#f8f9fa', border: '#495057' };
  add({
    id: c.id,
    label: c.name.slice(0, 26),
    group: 'component',
    shape: roleShape[c.role] ?? 'dot',
    size: 14,
    color: { background: rc.bg, border: rc.border, highlight: { background: rc.border, border: rc.border } },
    font: { size: 13, color: '#212529', face: 'system-ui, sans-serif' },
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
    label: `📘 ${(d.title ?? '(untitled)').replace(/[^ -~]/g, '').trim().slice(0, 30)}`,
    group: 'doc',
    shape: 'box',
    color: { background: '#fff3bf', border: '#e8590c', highlight: { background: '#ffe066', border: '#a61e00' } },
    font: { size: 13, color: '#7c2d12', face: 'system-ui, sans-serif', bold: true },
    margin: 8,
    title: `Doc: ${d.title}\n${(d.content ?? '').slice(0, 300)}`,
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
  :root{--bg:#f8f9fa;--panel:#ffffff;--text:#212529;--muted:#495057;--border:#ced4da;--accent:#1864ab}
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg);color:var(--text)}
  #top{padding:14px 20px;border-bottom:2px solid var(--border);background:var(--panel);display:flex;gap:28px;flex-wrap:wrap;align-items:center;box-shadow:0 1px 4px rgba(0,0,0,.04)}
  #top h1{margin:0;font-size:20px;font-weight:700;color:var(--accent)}
  .stat{font-size:14px;color:var(--muted)}
  .stat b{color:var(--text);font-weight:700;font-size:15px}
  .legend{display:flex;gap:14px;font-size:13px;align-items:center;flex-wrap:wrap}
  .legend span{display:inline-flex;align-items:center;gap:6px}
  .sw{width:16px;height:16px;display:inline-block;border:1px solid #888;border-radius:2px}
  .sw.dot{border-radius:50%}
  #mynet{width:100vw;height:calc(100vh - 74px);background:#ffffff}
  #detail{position:absolute;right:18px;top:94px;width:380px;max-height:70vh;overflow:auto;background:var(--panel);border:1px solid var(--border);padding:16px;font-size:14px;display:none;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12)}
  #detail h3{margin:0 0 8px;font-size:16px;color:var(--accent)}
  #detail small{color:var(--muted);font-family:ui-monospace,monospace;font-size:11px}
  #detail pre{white-space:pre-wrap;margin-top:10px;color:var(--text);font-size:13px;font-family:system-ui,sans-serif;line-height:1.5}
  #close{float:right;cursor:pointer;color:var(--muted);font-size:18px;line-height:1}
</style>
</head><body>
<div id="top">
  <h1>Avantis KG</h1>
  <span class="stat">modules <b>${stats.modules}</b></span>
  <span class="stat">components <b>${stats.components}</b></span>
  <span class="stat">pages <b>${stats.pages}</b></span>
  <span class="stat">docs <b>${stats.docs}</b></span>
  <span class="stat">edges <b>${stats.edges}</b></span>
  <span class="stat">user flows <b>${stats.flows}</b></span>
  <div class="legend">
    <span><span class="sw" style="background:#d0ebff;border-color:#1971c2"></span>page</span>
    <span><span class="sw" style="background:#d6336c"></span>perps</span>
    <span><span class="sw" style="background:#2b8a3e"></span>yield</span>
    <span><span class="sw" style="background:#495057"></span>general</span>
    <span><span class="sw dot" style="background:#ffffff;border-color:#343a40"></span>button</span>
    <span><span class="sw" style="background:#d3f9d8;border-color:#2f9e44"></span>input</span>
    <span><span class="sw" style="background:#ffe3e3;border-color:#c92a2a"></span>slider</span>
    <span><span class="sw" style="background:#d0bfff;border-color:#5f3dc4"></span>switch</span>
    <span><span class="sw" style="background:#fff3bf;border-color:#e8590c"></span>doc</span>
  </div>
</div>
<div id="mynet"></div>
<div id="detail"><span id="close">×</span><h3 id="dt"></h3><small id="ds"></small><pre id="dp"></pre></div>
<script>
const nodes = new vis.DataSet(${JSON.stringify(nodes)});
const edges = new vis.DataSet(${JSON.stringify(vedges)});
const net = new vis.Network(document.getElementById('mynet'),{nodes,edges},{
  physics:{enabled:true,stabilization:{iterations:400},barnesHut:{gravitationalConstant:-18000,springLength:160,springConstant:0.04,damping:0.4}},
  interaction:{hover:true,tooltipDelay:200,navigationButtons:true,keyboard:true,zoomView:true},
  nodes:{borderWidth:2,shadow:{enabled:true,size:4,x:1,y:2,color:'rgba(0,0,0,0.12)'}},
  edges:{smooth:{type:'continuous',roundness:0.3},font:{face:'system-ui,sans-serif',size:11,strokeWidth:3,strokeColor:'#ffffff'}},
  layout:{improvedLayout:true},
});
const det=document.getElementById('detail');
const dt=document.getElementById('dt'),ds=document.getElementById('ds'),dp=document.getElementById('dp');
document.getElementById('close').onclick=()=>det.style.display='none';
net.on('click', p=>{
  if(p.nodes.length===0){det.style.display='none';return;}
  const n=nodes.get(p.nodes[0]);
  dt.textContent=(n.label||n.id).replace(/^[^\\w]*\\s*/,'');
  ds.textContent=n.id;
  dp.textContent=n.title||'';
  det.style.display='block';
});
</script>
</body></html>`;

const outPath = join(outputDir, 'kg-graph.html');
writeFileSync(outPath, html, 'utf-8');
console.log(`written: ${outPath} (${html.length} bytes)`);
console.log(JSON.stringify(stats, null, 2));

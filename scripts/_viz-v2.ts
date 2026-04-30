#!/usr/bin/env npx tsx
/**
 * KG v2 visualizer — reads kg-v2.json, emits a single self-contained HTML
 * (vis-network from CDN). Open in a browser. Layers colour-coded; click a
 * node for full JSON, click an edge for the edge type + label. Filter
 * controls let you toggle layers + edge types live.
 *
 *   npx tsx scripts/_viz-v2.ts --dir output/developer-avantisfi-com
 *   open output/developer-avantisfi-com/kg-v2.html
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function argVal(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const outputDir = argVal('--dir', join(process.cwd(), 'output', 'developer-avantisfi-com'));
const kgPath = join(outputDir, 'kg-v2.json');
const kg = JSON.parse(readFileSync(kgPath, 'utf-8'));

const LAYER_COLORS: Record<string, string> = {
  structural: '#4a90e2',
  behavioral: '#7ed321',
  technical:  '#f5a623',
  semantic:   '#bd10e0',
};

const KIND_SHAPE: Record<string, string> = {
  page: 'box', section: 'box', component: 'dot', element: 'dot',
  state: 'ellipse', action: 'diamond',
  apiCall: 'triangle', contractCall: 'triangleDown', event: 'star', errorResponse: 'square',
  flow: 'database', docSection: 'hexagon', constraint: 'square', asset: 'dot', feature: 'star',
};

const EDGE_COLOR: Record<string, string> = {
  CONTAINS: '#888',
  REQUIRES_STATE: '#7ed321',
  TRANSITIONS_TO: '#2ecc71',
  FAILS_TO: '#e74c3c',
  PERFORMED_VIA: '#95a5a6',
  TRIGGERS_API_CALL: '#f5a623',
  INVOKES_CONTRACT_CALL: '#e67e22',
  EMITS_EVENT: '#9b59b6',
  RETURNS_ERROR: '#c0392b',
  START_STATE: '#bd10e0',
  END_STATE: '#bd10e0',
  INCLUDES_ACTION: '#bd10e0',
  DESCRIBED_BY: '#34495e',
  CONSTRAINS: '#16a085',
  OPERATES_ON: '#1abc9c',
  EXPOSES_FEATURE: '#27ae60',
};

const visNodes = kg.nodes.map((n: any) => ({
  id: n.id,
  label: (n.label ?? n.kind ?? n.id).slice(0, 32),
  title: `${n.kind} · ${n.layer}\n${n.label ?? ''}\n${n.id}`,
  color: { background: LAYER_COLORS[n.layer] ?? '#999', border: n.isError ? '#c0392b' : '#222' },
  shape: KIND_SHAPE[n.kind] ?? 'dot',
  borderWidth: n.isError ? 3 : 1,
  layer: n.layer,
  kind: n.kind,
  rawId: n.id,
}));

const visEdges = kg.edges.map((e: any) => ({
  from: e.from,
  to: e.to,
  arrows: 'to',
  color: { color: EDGE_COLOR[e.edgeType] ?? '#666', opacity: 0.5 },
  label: '',
  title: `${e.edgeType}${e.label ? '\n' + e.label : ''}`,
  edgeType: e.edgeType,
}));

const nodeMap = new Map<string, any>();
for (const n of kg.nodes) nodeMap.set(n.id, n);

const layerCounts: Record<string, number> = {};
for (const n of kg.nodes) layerCounts[n.layer] = (layerCounts[n.layer] ?? 0) + 1;

const edgeTypeCounts: Record<string, number> = {};
for (const e of kg.edges) edgeTypeCounts[e.edgeType] = (edgeTypeCounts[e.edgeType] ?? 0) + 1;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>KG v2 — ${kg.dappUrl}</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: #1e1e1e; color: #ddd; }
  #header { padding: 8px 16px; background: #2d2d2d; border-bottom: 1px solid #444; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  #header h1 { margin: 0; font-size: 14px; font-weight: 500; }
  #header .stats { color: #aaa; font-size: 12px; }
  #header .filters { display: flex; gap: 12px; flex-wrap: wrap; }
  #header label { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; user-select: none; padding: 2px 6px; border-radius: 3px; background: #383838; }
  #header input[type="checkbox"] { margin: 0; }
  #network { width: 100vw; height: calc(100vh - 90px); }
  #detail { position: fixed; right: 0; top: 90px; width: 380px; height: calc(100vh - 90px); background: #2d2d2d; border-left: 1px solid #444; padding: 12px; overflow: auto; box-shadow: -2px 0 12px rgba(0,0,0,0.3); transform: translateX(100%); transition: transform .2s; }
  #detail.open { transform: translateX(0); }
  #detail h2 { margin: 0 0 8px; font-size: 14px; }
  #detail pre { background: #1e1e1e; padding: 8px; border-radius: 4px; overflow: auto; font-size: 11px; line-height: 1.4; }
  #detail .close { float: right; cursor: pointer; color: #888; }
  .legend-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: middle; margin-right: 4px; }
</style></head>
<body>
<div id="header">
  <h1>KG v2 · ${kg.dappUrl}</h1>
  <div class="stats">${kg.nodes.length} nodes · ${kg.edges.length} edges · crawl ${kg.crawlId}</div>
  <div class="filters" id="layerFilters">
    ${Object.entries(LAYER_COLORS).map(([l, c]) => `<label><span class="legend-swatch" style="background:${c}"></span><input type="checkbox" data-layer="${l}" checked>${l} (${layerCounts[l] ?? 0})</label>`).join('')}
  </div>
  <div class="filters" id="edgeFilters">
    ${Object.entries(EDGE_COLOR).map(([t, c]) => `<label title="${t}"><span class="legend-swatch" style="background:${c}"></span><input type="checkbox" data-edge="${t}" ${['CONTAINS','PERFORMED_VIA','INVOKES_CONTRACT_CALL'].includes(t) ? '' : 'checked'}>${t} (${edgeTypeCounts[t] ?? 0})</label>`).join('')}
  </div>
</div>
<div id="network"></div>
<div id="detail"><span class="close" onclick="document.getElementById('detail').classList.remove('open')">×</span><h2>Click a node or edge</h2></div>
<script>
const RAW_NODES = ${JSON.stringify(visNodes)};
const RAW_EDGES = ${JSON.stringify(visEdges)};
const NODE_DETAIL = ${JSON.stringify(Object.fromEntries(kg.nodes.map((n: any) => [n.id, n])))};
const EDGE_DETAIL = ${JSON.stringify(kg.edges.map((e: any) => ({ id: e.id, from: e.from, to: e.to, edgeType: e.edgeType, label: e.label, provenance: e.provenance, inferenceSource: e.inferenceSource })))};

const nodes = new vis.DataSet();
const edges = new vis.DataSet();

function rebuild() {
  const enabledLayers = new Set([...document.querySelectorAll('#layerFilters input:checked')].map(i => i.dataset.layer));
  const enabledEdges = new Set([...document.querySelectorAll('#edgeFilters input:checked')].map(i => i.dataset.edge));
  const visibleNodes = RAW_NODES.filter(n => enabledLayers.has(n.layer));
  const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
  const visibleEdges = RAW_EDGES.filter(e => enabledEdges.has(e.edgeType) && visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to));
  nodes.clear(); edges.clear();
  nodes.add(visibleNodes); edges.add(visibleEdges);
}

const container = document.getElementById('network');
const network = new vis.Network(container, { nodes, edges }, {
  physics: { stabilization: { iterations: 200 }, barnesHut: { gravitationalConstant: -2000, springLength: 120 } },
  interaction: { hover: true, tooltipDelay: 100 },
  edges: { smooth: { type: 'continuous' } },
  nodes: { font: { color: '#fff', size: 11 } },
});

network.on('click', (params) => {
  const det = document.getElementById('detail');
  if (params.nodes.length > 0) {
    const n = NODE_DETAIL[params.nodes[0]];
    det.querySelector('h2').textContent = (n.kind + ': ' + (n.label ?? n.id)).slice(0, 80);
    det.querySelector('pre')?.remove();
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(n, null, 2);
    det.appendChild(pre);
    det.classList.add('open');
  } else if (params.edges.length > 0) {
    const e = EDGE_DETAIL.find(x => x.id === params.edges[0]);
    if (!e) return;
    det.querySelector('h2').textContent = e.edgeType;
    det.querySelector('pre')?.remove();
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(e, null, 2);
    det.appendChild(pre);
    det.classList.add('open');
  }
});

document.querySelectorAll('#header input[type=checkbox]').forEach(cb => cb.addEventListener('change', rebuild));
rebuild();
</script></body></html>`;

const outPath = join(outputDir, 'kg-v2.html');
writeFileSync(outPath, html);
console.log(`[viz-v2] wrote ${outPath}`);
console.log(`[viz-v2] nodes: ${kg.nodes.length} · edges: ${kg.edges.length}`);
console.log(`[viz-v2] open in browser to explore. Filters at top, click nodes/edges for detail.`);

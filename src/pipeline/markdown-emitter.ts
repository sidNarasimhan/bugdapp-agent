/**
 * Markdown Emitter — deterministic walker over modules + KG that emits one
 * compact .md per (sub)module + an index.md at the top. These files are the
 * RAG substrate consumed by src/agent/rag.ts at runtime.
 *
 * Each .md is written to be 500–2500 bytes. Files start with a contextual
 * prefix ("This document describes the <name> module within <dApp>, used by
 * flows X/Y/Z") so Anthropic's contextual-retrieval trick applies without
 * separate embedding infrastructure.
 *
 * No LLM. Pure walk.
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, DAppModule, KnowledgeGraph } from '../agent/state.js';

interface ModuleEdge { from: string; to: string; moduleId: string; type: 'leads_to_next' | 'interacts_with'; evidence: string; }

export function createMarkdownEmitterNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config, modules, knowledgeGraph: kg } = state;
    if (!modules || modules.length === 0) {
      console.log('[MarkdownEmitter] no modules, skipping');
      return {};
    }

    const knowledgeDir = join(config.outputDir, 'knowledge');
    // Clean rebuild — safe: regenerated deterministically from modules.json
    if (existsSync(knowledgeDir)) {
      try { rmSync(knowledgeDir, { recursive: true, force: true }); } catch {}
    }
    mkdirSync(knowledgeDir, { recursive: true });

    const dAppName = (state.crawlData as any)?.context?.title || new URL(config.url).hostname;
    const written: Array<{ path: string; bytes: number }> = [];

    // Load module-edges.json if Relationship Inferrer has run — surface edges
    // per-module so the agent sees flow ordering via RAG instead of leaving
    // them as dead data.
    const edgesPath = join(config.outputDir, 'module-edges.json');
    const moduleEdges: ModuleEdge[] = existsSync(edgesPath)
      ? (() => { try { return JSON.parse(readFileSync(edgesPath, 'utf-8')); } catch { return []; } })()
      : [];

    // Index
    const indexMd = emitIndex(dAppName, config.url, modules);
    const indexPath = join(knowledgeDir, 'index.md');
    writeFileSync(indexPath, indexMd, 'utf-8');
    written.push({ path: indexPath, bytes: indexMd.length });

    // Per-module (recursive)
    const allModules = flatten(modules);
    for (const m of allModules) {
      const md = emitModule(dAppName, m, kg, moduleEdges);
      const slug = m.id.replace(/^module:/, '').replace(/:/g, '.');
      const path = join(knowledgeDir, `${slug}.md`);
      writeFileSync(path, md, 'utf-8');
      written.push({ path, bytes: md.length });
    }

    const totalBytes = written.reduce((s, w) => s + w.bytes, 0);
    console.log(`[MarkdownEmitter] wrote ${written.length} files, ${totalBytes} bytes total, avg ${Math.round(totalBytes / written.length)}B/file`);
    const tooBig = written.filter(w => w.bytes > 3000);
    if (tooBig.length > 0) {
      console.warn(`[MarkdownEmitter] ${tooBig.length} file(s) >3KB — consider truncating:`);
      for (const t of tooBig) console.warn(`   ${t.path}: ${t.bytes}B`);
    }
    return {};
  };
}

// ── index.md ────────────────────────────────────────────────────────────

function emitIndex(dAppName: string, url: string, modules: DAppModule[]): string {
  // Keep tight: dApp id + module slug table. Module detail lives in each module's
  // own .md, loaded via RAG when the agent operates on it.
  const lines: string[] = [];
  lines.push(`# ${dAppName} — module map`);
  lines.push('');
  lines.push(`Call \`get_module_context\` with a slug below to load full module detail.`);
  lines.push('');
  for (const m of modules) {
    const slug = m.id.replace(/^module:/, '').replace(/:/g, '.');
    const arch = m.archetype && m.archetype !== 'general' ? ` [${m.archetype}]` : '';
    const pages = m.pageIds.length ? ` · ${m.pageIds.map(p => p.replace(/^page:/, '')).join(',')}` : '';
    lines.push(`- \`${slug}\` — **${m.name}**${arch}${pages}`);
    if (m.subModules && m.subModules.length > 0) {
      for (const sm of m.subModules) {
        const smSlug = sm.id.replace(/^module:/, '').replace(/:/g, '.');
        const smArch = sm.archetype && sm.archetype !== 'general' ? ` [${sm.archetype}]` : '';
        lines.push(`  - \`${smSlug}\` — ${sm.name}${smArch}`);
      }
    }
  }
  return lines.join('\n');
}

// ── per-module .md ──────────────────────────────────────────────────────

function emitModule(dAppName: string, m: DAppModule, kg: KnowledgeGraph, moduleEdges: ModuleEdge[] = []): string {
  const lines: string[] = [];

  // Contextual prefix (Anthropic's contextual-retrieval trick)
  const flowHint = m.subModules && m.subModules.length
    ? ` It contains sub-modules: ${m.subModules.map(s => s.name).join(', ')}.`
    : '';
  lines.push(`_This document describes the **${m.name}** module within ${dAppName}. Archetype: ${m.archetype ?? 'general'}.${flowHint}_`);
  lines.push('');

  // Header
  lines.push(`# ${m.name}`);
  lines.push('');
  if (m.description) lines.push(m.description);
  if (m.businessPurpose && m.businessPurpose !== m.description) {
    lines.push('');
    lines.push(`**Purpose:** ${m.businessPurpose}`);
  }
  lines.push('');

  // Pages
  if (m.pageIds.length) {
    const pageLines = m.pageIds.map(pid => {
      const p = kg.pages.find(p => p.id === pid);
      return p ? `- ${p.name} — ${p.url}` : `- ${pid}`;
    });
    lines.push(`## Pages`);
    lines.push(...pageLines);
    lines.push('');
  }

  // Triggered by (entry points)
  if (m.triggeredByComponentIds.length) {
    const triggers = m.triggeredByComponentIds
      .map(cid => kg.components.find(c => c.id === cid))
      .filter(Boolean)
      .map(c => `- ${c!.role}: "${c!.name}"${c!.pageId ? ` (on ${c!.pageId})` : ''}`);
    if (triggers.length) {
      lines.push(`## Entry points (click these to open this module)`);
      lines.push(...triggers);
      lines.push('');
    }
  }

  // Components (grouped by role)
  if (m.componentIds.length) {
    const byRole: Record<string, string[]> = {};
    for (const cid of m.componentIds) {
      const c = kg.components.find(cc => cc.id === cid);
      if (!c || !c.name || c.disabled) continue;
      (byRole[c.role] = byRole[c.role] || []).push(c.name);
    }
    if (Object.keys(byRole).length) {
      lines.push(`## Components`);
      for (const role of Object.keys(byRole)) {
        const names = [...new Set(byRole[role])].slice(0, 20);
        lines.push(`- **${role}**: ${names.map(n => `\`${n}\``).join(', ')}`);
      }
      lines.push('');
    }
  }

  // Constraints
  if (m.constraintIds.length) {
    const cs = m.constraintIds
      .map((cid, i) => (kg.constraints ?? []).find((c: any, j: number) => (c.id ?? `constraint:${j}`) === cid))
      .filter(Boolean) as any[];
    if (cs.length) {
      lines.push(`## Constraints`);
      for (const c of cs) {
        const name = c.name ?? c.rule ?? 'constraint';
        const val = c.value ? ` = ${c.value}` : '';
        const impl = c.testImplication ? ` — ${c.testImplication}` : '';
        lines.push(`- **${name}**${val}${impl}`);
      }
      lines.push('');
    }
  }

  // Docs (truncated — keep prompt tight; agent can fetch full doc text from KG if needed)
  if (m.docSectionIds.length) {
    const docs = (kg.docSections ?? [])
      .filter((d: any, i: number) => m.docSectionIds.includes(d.id ?? `doc:${i}`))
      .slice(0, 3);
    if (docs.length) {
      lines.push(`## Docs`);
      for (const d of docs as any[]) {
        const snippet = String(d.content ?? d.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 110);
        lines.push(`- **${d.title ?? '(untitled)'}**: ${snippet}${snippet.length >= 110 ? '…' : ''}`);
      }
      lines.push('');
    }
  }

  // Observed rules (regex-swept from KG actions/interactions/edgeCases for
  // runtime-observed thresholds like "Minimum position size is $100" that
  // comprehension didn't promote into structured constraints)
  const observedRules = sweepRules(kg, m);
  if (observedRules.length) {
    lines.push(`## Observed rules (from crawler interactions)`);
    for (const r of observedRules.slice(0, 8)) lines.push(`- ${r}`);
    lines.push('');
  }

  // Step sequencing — from Relationship Inferrer's leads_to_next edges,
  // scoped to this module. Helps the agent know "after clicking X, the next
  // logical thing is Y" without needing to re-discover from the DOM.
  const moduleLeads = moduleEdges.filter(e => e.moduleId === m.id && e.type === 'leads_to_next');
  if (moduleLeads.length) {
    lines.push(`## Step sequencing (leads-to-next, observed in user flows)`);
    const chains = buildChains(moduleLeads, kg);
    for (const chain of chains.slice(0, 6)) lines.push(`- ${chain}`);
    lines.push('');
  }

  // APIs
  if (m.apiEndpointIds.length) {
    const apis = (kg.apiEndpoints ?? [])
      .filter((a: any, i: number) => m.apiEndpointIds.includes(a.id ?? `api:${i}`))
      .slice(0, 10);
    if (apis.length) {
      lines.push(`## APIs`);
      for (const a of apis as any[]) {
        lines.push(`- \`${a.path ?? a.url ?? JSON.stringify(a).slice(0, 80)}\``);
      }
      lines.push('');
    }
  }

  // Contracts
  if (m.contractAddresses.length) {
    const known = (kg.contracts ?? []) as any[];
    lines.push(`## Contracts`);
    for (const addr of m.contractAddresses.slice(0, 8)) {
      const c = known.find((x: any) => (x.address ?? '').toLowerCase() === addr);
      lines.push(`- \`${addr}\`${c?.role ? ` — ${c.role}` : ''}${c?.name ? ` (${c.name})` : ''}`);
    }
    lines.push('');
  }

  // Sub-module pointers
  if (m.subModules && m.subModules.length > 0) {
    lines.push(`## Sub-modules`);
    for (const sm of m.subModules) {
      const slug = sm.id.replace(/^module:/, '').replace(/:/g, '.');
      lines.push(`- **${sm.name}** → load \`${slug}.md\` — ${sm.description || sm.businessPurpose}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Chain consecutive leads_to_next edges into human-readable sequences. */
function buildChains(edges: ModuleEdge[], kg: KnowledgeGraph): string[] {
  const nameFor = (cid: string) => {
    const c = kg.components.find(x => x.id === cid);
    return c ? `${c.role}:"${(c.name ?? '').slice(0, 30)}"` : cid;
  };
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  // Start at nodes that have no inbound edge in this module
  const incoming = new Set(edges.map(e => e.to));
  const starts = [...adj.keys()].filter(k => !incoming.has(k));
  const chains: string[] = [];
  const seen = new Set<string>();
  const walk = (node: string, path: string[]) => {
    if (seen.has(node) || path.length > 6) {
      chains.push(path.map(nameFor).join(' → '));
      return;
    }
    seen.add(node);
    const nexts = adj.get(node);
    if (!nexts || nexts.length === 0) {
      chains.push(path.map(nameFor).join(' → '));
      return;
    }
    for (const next of nexts.slice(0, 3)) walk(next, [...path, next]);
  };
  for (const s of starts.slice(0, 5)) walk(s, [s]);
  return [...new Set(chains)].filter(c => c.includes('→'));
}

function sweepRules(kg: KnowledgeGraph, m: DAppModule): string[] {
  const patterns = [
    /\b(minimum|maximum|min|max)\s+(position|leverage|amount|collateral|size|deposit|withdrawal|trade|order)/i,
    /\b\d+(?:\.\d+)?\s*(%|x|usd|usdc|eth|btc|sol|bps)\b/i,
    /\b(insufficient|exceeds|too\s+(low|high|small|large))\b/i,
    /\b(requires?|must|only|restricted|prohibited|not\s*allowed|cannot)\b.{0,40}\d/i,
  ];
  const seen = new Set<string>();
  const hits: string[] = [];
  const pageIds = new Set(m.pageIds);

  const visit = (s: unknown) => {
    if (typeof s !== 'string' || s.length < 10 || s.length > 240) return;
    const clean = s.replace(/^[a-z0-9]{1,6}:/i, '').replace(/\s+/g, ' ').trim();
    if (clean.length < 10) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    if (!patterns.some(p => p.test(clean))) return;
    seen.add(key);
    hits.push(clean);
  };

  // Scope to actions involving this module's components OR interactions on module's pages
  for (const a of kg.actions ?? []) {
    if (!m.componentIds.includes(a.componentId)) continue;
    for (const s of a.newElementsAppeared ?? []) visit(s);
    for (const s of a.elementsDisappeared ?? []) visit(s);
    visit(a.resultDescription);
  }
  // Page-scoped sweep from any string field in the KG that mentions the module's pages
  const walk = (node: any, depth = 0) => {
    if (hits.length >= 12 || depth > 6) return;
    if (typeof node === 'string') visit(node);
    else if (Array.isArray(node)) node.forEach(x => walk(x, depth + 1));
    else if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    }
  };
  if (pageIds.size > 0) {
    // Only scan edgeCases + testCases (KG's higher-level structures)
    walk(kg.edgeCases ?? []);
    walk(kg.testCases ?? []);
  }
  return hits;
}

function flatten(modules: DAppModule[]): DAppModule[] {
  const out: DAppModule[] = [];
  const walk = (ms: DAppModule[]) => {
    for (const m of ms) {
      out.push(m);
      if (m.subModules && m.subModules.length > 0) walk(m.subModules);
    }
  };
  walk(modules);
  return out;
}

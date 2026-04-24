/**
 * Markdown Emitter — emits per-module .md files as RAG substrate.
 *
 * Rewritten for the capability-centric model. Each module's .md now shows:
 *   - contextual prefix (Anthropic's contextual-retrieval trick)
 *   - module kind + pages + business purpose
 *   - cross-module relations (dependsOn / produces / consumedBy / navigatesTo)
 *   - semantic Controls (grouped by kind, with wiring)
 *   - full Capability tree (intent, preconds, control path, option choices,
 *     docs, constraints, edge cases, personas)
 *   - structured doc excerpts (topics + rules, not raw text blobs)
 *
 * No LLM. All data hydrated from disk/state.
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  AgentStateType, DAppModule, Control, Capability, StructuredDoc, KnowledgeGraph,
} from '../agent/state.js';

export function createMarkdownEmitterNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config, knowledgeGraph: kg } = state;
    const modules: DAppModule[] = state.modules && state.modules.length > 0
      ? state.modules
      : (() => { const p = join(config.outputDir, 'modules.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    if (modules.length === 0) { console.log('[MarkdownEmitter] no modules, skipping'); return {}; }

    const controls: Control[] = state.controls && state.controls.length > 0
      ? state.controls
      : (() => { const p = join(config.outputDir, 'controls.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const caps: Capability[] = state.capabilities && state.capabilities.length > 0
      ? state.capabilities
      : (() => { const p = join(config.outputDir, 'capabilities.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const docs: StructuredDoc[] = state.structuredDocs && state.structuredDocs.length > 0
      ? state.structuredDocs
      : (() => { const p = join(config.outputDir, 'structured-docs.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();

    const knowledgeDir = join(config.outputDir, 'knowledge');
    if (existsSync(knowledgeDir)) { try { rmSync(knowledgeDir, { recursive: true, force: true }); } catch {} }
    mkdirSync(knowledgeDir, { recursive: true });

    const dAppName = (state.crawlData as any)?.context?.title || new URL(config.url).hostname;
    const moduleById = new Map(modules.map(m => [m.id, m]));
    const controlsByModule = new Map<string, Control[]>();
    for (const c of controls) {
      if (!controlsByModule.has(c.moduleId)) controlsByModule.set(c.moduleId, []);
      controlsByModule.get(c.moduleId)!.push(c);
    }
    const capsByModule = new Map<string, Capability[]>();
    for (const c of caps) {
      if (!capsByModule.has(c.moduleId)) capsByModule.set(c.moduleId, []);
      capsByModule.get(c.moduleId)!.push(c);
    }
    const docById = new Map(docs.map(d => [d.id, d]));

    const written: Array<{ path: string; bytes: number }> = [];

    // Index
    const indexMd = emitIndex(dAppName, config.url, modules);
    const indexPath = join(knowledgeDir, 'index.md');
    writeFileSync(indexPath, indexMd, 'utf-8');
    written.push({ path: indexPath, bytes: indexMd.length });

    // Per-module
    for (const m of modules) {
      const md = emitModule(dAppName, m, moduleById, controlsByModule.get(m.id) ?? [], capsByModule.get(m.id) ?? [], docById, kg);
      const slug = m.id.replace(/^module:/, '').replace(/:/g, '.');
      const path = join(knowledgeDir, `${slug}.md`);
      writeFileSync(path, md, 'utf-8');
      written.push({ path, bytes: md.length });
    }

    const totalBytes = written.reduce((s, w) => s + w.bytes, 0);
    console.log(`[MarkdownEmitter] wrote ${written.length} files, ${totalBytes} bytes total, avg ${Math.round(totalBytes / written.length)}B/file`);
    return {};
  };
}

// ── index.md ────────────────────────────────────────────────────────────

function emitIndex(dAppName: string, url: string, modules: DAppModule[]): string {
  const lines: string[] = [];
  lines.push(`# ${dAppName} — module map`);
  lines.push('');
  lines.push(`URL: ${url}`);
  lines.push('');
  lines.push('Call `get_module_context` with a slug below to load full module detail.');
  lines.push('');
  lines.push('## Modules');
  lines.push('');
  for (const m of modules) {
    const slug = m.id.replace(/^module:/, '').replace(/:/g, '.');
    const arch = m.archetype && m.archetype !== 'general' ? ` [${m.archetype}]` : '';
    const pages = m.pageIds.length ? ` · pages: ${m.pageIds.map(p => p.replace(/^page:/, '')).join(',')}` : '';
    lines.push(`- \`${slug}\` — **${m.name}** (${m.kind})${arch}${pages}`);
  }
  lines.push('');
  lines.push('## Cross-module topology');
  lines.push('');
  for (const m of modules) {
    const rel: string[] = [];
    if (m.relations.dependsOn?.length) rel.push(`depends_on: ${m.relations.dependsOn.join(', ')}`);
    if (m.relations.produces?.length) rel.push(...m.relations.produces.map(p => `produces "${p.entity}" → ${p.consumedBy.join(', ')}`));
    if (m.relations.navigatesTo?.length) rel.push(`navigates_to: ${m.relations.navigatesTo.join(', ')}`);
    if (m.relations.crossRefs?.length) rel.push(`cross_refs: ${m.relations.crossRefs.join(', ')}`);
    if (rel.length) {
      lines.push(`- **${m.name}**:`);
      for (const r of rel) lines.push(`  - ${r}`);
    }
  }
  return lines.join('\n');
}

// ── per-module .md ──────────────────────────────────────────────────────

function emitModule(
  dAppName: string,
  m: DAppModule,
  moduleById: Map<string, DAppModule>,
  mControls: Control[],
  mCaps: Capability[],
  docById: Map<string, StructuredDoc>,
  kg: KnowledgeGraph,
): string {
  const lines: string[] = [];

  // Contextual prefix
  const context = `_This document describes the **${m.name}** module within ${dAppName} (kind: ${m.kind}${m.archetype ? `, archetype: ${m.archetype}` : ''}). It has ${mControls.length} controls and ${mCaps.length} capabilities._`;
  lines.push(context, '');

  // Header
  lines.push(`# ${m.name}`, '');
  if (m.description) lines.push(m.description);
  if (m.businessPurpose && m.businessPurpose !== m.description) {
    lines.push('', `**Purpose:** ${m.businessPurpose}`);
  }
  lines.push('');

  // Pages
  if (m.pageIds.length) {
    lines.push('## Pages');
    for (const pid of m.pageIds) {
      const p = kg.pages.find(p => p.id === pid);
      lines.push(`- ${p ? `${p.name} — ${p.url}` : pid}`);
    }
    lines.push('');
  }

  // Cross-module relations
  const rel: string[] = [];
  for (const dep of m.relations.dependsOn ?? []) {
    const dm = moduleById.get(dep); if (dm) rel.push(`- **depends on** ${dm.name} (${dep})`);
  }
  for (const p of m.relations.produces ?? []) {
    const consumers = p.consumedBy.map(id => moduleById.get(id)?.name ?? id).join(', ');
    rel.push(`- **produces** \`${p.entity}\` → consumed by ${consumers}`);
  }
  for (const p of m.relations.consumedBy ?? []) {
    const producers = p.producedBy.map(id => moduleById.get(id)?.name ?? id).join(', ');
    rel.push(`- **consumes** \`${p.entity}\` from ${producers}`);
  }
  for (const nav of m.relations.navigatesTo ?? []) {
    const nm = moduleById.get(nav); if (nm) rel.push(`- **navigates to** ${nm.name} (${nav})`);
  }
  for (const cr of m.relations.crossRefs ?? []) {
    const cm = moduleById.get(cr); if (cm) rel.push(`- cross-ref: ${cm.name} (${cr})`);
  }
  if (rel.length) { lines.push('## Cross-module relations'); lines.push(...rel); lines.push(''); }

  // Controls grouped by kind
  if (mControls.length) {
    const byKind: Record<string, Control[]> = {};
    for (const c of mControls) (byKind[c.kind] = byKind[c.kind] || []).push(c);
    lines.push('## Controls');
    const order = ['submit-cta', 'modal-selector', 'radio', 'tabs', 'percentage-picker', 'slider', 'input', 'toggle', 'dropdown', 'link', 'tab', 'button'];
    for (const kind of order) {
      const list = byKind[kind]; if (!list || list.length === 0) continue;
      lines.push(`### ${kind}`);
      for (const c of list) {
        const opts = c.options?.length ? ` — options: ${c.options.slice(0, 8).join(', ')}${c.options.length > 8 ? `, +${c.options.length - 8} more` : ''}` : '';
        const unit = c.unit ? ` (${c.unit})` : '';
        const gates = c.gates?.length ? `; gates: ${c.gates.join(', ')}` : '';
        const affectedBy = c.affectedBy?.length ? `; affected_by: ${c.affectedBy.join(', ')}` : '';
        lines.push(`- **${c.name}** \`${c.id}\`${unit}${opts}${gates}${affectedBy}`);
        if (c.description) lines.push(`    ${c.description}`);
      }
    }
    lines.push('');
  }

  // Capabilities
  if (mCaps.length) {
    lines.push('## Capabilities');
    lines.push('');
    for (const cap of mCaps) {
      lines.push(`### ${cap.name || cap.id}`);
      if (cap.intent) lines.push(cap.intent);
      lines.push('');
      if (cap.preconditions.length) lines.push(`- **Preconditions:** ${cap.preconditions.join('; ')}`);
      // Control path with option choices
      const pathDisplay = cap.controlPath.map(cid => {
        const choice = cap.optionChoices[cid];
        return choice ? `${cid}=${choice}` : cid;
      }).join(' → ');
      if (pathDisplay) lines.push(`- **Control path:** ${pathDisplay}`);
      if (Object.keys(cap.optionChoices).length) {
        const choices = Object.entries(cap.optionChoices).map(([k, v]) => `${k}: ${v}`).join(', ');
        lines.push(`- **Option choices:** ${choices}`);
      }
      if (cap.docIds.length) {
        const titles = cap.docIds.map(id => docById.get(id)?.title ?? id).slice(0, 4);
        lines.push(`- **Docs cited:** ${titles.join('; ')}`);
      }
      if (cap.successCriteria) lines.push(`- **Success:** ${cap.successCriteria}`);
      if (cap.personas.length) lines.push(`- **Personas:** ${cap.personas.join(', ')}`);
      lines.push(`- **Risk:** ${cap.riskClass}`);
      if (cap.edgeCases.length) {
        lines.push(`- **Edge cases (${cap.edgeCases.length}):**`);
        for (const ec of cap.edgeCases.slice(0, 8)) {
          lines.push(`    - ${ec.name} → expect: ${ec.expectedRejection.slice(0, 140)}`);
        }
        if (cap.edgeCases.length > 8) lines.push(`    - … and ${cap.edgeCases.length - 8} more`);
      }
      lines.push('');
    }
  }

  // Structured doc excerpts
  const mDocs = m.docSectionIds.map(id => docById.get(id)).filter(Boolean) as StructuredDoc[];
  if (mDocs.length) {
    lines.push('## Docs (structured)');
    for (const d of mDocs.slice(0, 5)) {
      const topics = d.topics.slice(0, 4).join(', ');
      lines.push(`- **${d.title}**${topics ? ` · topics: ${topics}` : ''}`);
      for (const rule of d.rules.slice(0, 3)) lines.push(`    - rule: ${rule.slice(0, 160)}`);
    }
    lines.push('');
  }

  // Contracts
  if (m.contractAddresses.length) {
    lines.push('## Contracts');
    for (const addr of m.contractAddresses.slice(0, 8)) {
      const c: any = (kg.contracts ?? []).find((x: any) => (x.address ?? '').toLowerCase() === addr);
      lines.push(`- \`${addr}\`${c?.role ? ` — ${c.role}` : ''}${c?.name ? ` (${c.name})` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

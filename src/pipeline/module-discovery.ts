/**
 * Module Discovery — produces a rich module shape with:
 *   - kind: primary | cross-cutting | shared
 *   - multi-page hosting (cross-cutting modules live on every page)
 *   - cross-module relations: dependsOn, produces, consumedBy, navigatesTo
 *
 * The LLM is grounded by: kg.pages, components-by-page, structured docs,
 * api endpoints, comprehension archetype. Validates every id in the output.
 *
 * One LLM call (~$0.08). Output: state.modules + modules.json on disk.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../core/llm.js';
import type { AgentStateType, DAppModule, ModuleKind, KnowledgeGraph, StructuredDoc } from '../agent/state.js';

const MODEL = process.env.MODULE_DISCOVERY_MODEL ?? 'anthropic/claude-sonnet-4.5';

export function createModuleDiscoveryNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { knowledgeGraph: kg, config } = state;
    // Hydrate structured docs + comprehension from disk if not in state
    const docs: StructuredDoc[] = state.structuredDocs && state.structuredDocs.length > 0
      ? state.structuredDocs
      : (() => { const p = join(config.outputDir, 'structured-docs.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const compPath = join(config.outputDir, 'comprehension.json');
    const comp = existsSync(compPath) ? JSON.parse(readFileSync(compPath, 'utf-8')) : null;

    console.log('━━━ Module Discovery: modules + kind + cross-module edges ━━━');

    if ((kg.pages?.length ?? 0) === 0) {
      console.log('[ModuleDiscovery] empty KG (0 pages) — refusing to hallucinate modules. Skipping.');
      return {};
    }

    const client = createOpenRouterClient(config.apiKey || process.env.OPENROUTER_API_KEY);

    const digest = buildDigest(kg, docs, comp);
    console.log(`[ModuleDiscovery] digest: ${digest.bytes} bytes (${digest.pages.length} pages, ${digest.docs.length} docs)`);

    const raw = await askDiscovery(client, digest);
    const modules = validate(raw, kg, docs);
    console.log(`[ModuleDiscovery] ${modules.length} modules — by kind:`, countBy(modules, m => m.kind));
    const totalEdges = modules.reduce((n, m) =>
      n + (m.relations.dependsOn?.length ?? 0) + (m.relations.produces?.length ?? 0) +
      (m.relations.consumedBy?.length ?? 0) + (m.relations.navigatesTo?.length ?? 0) +
      (m.relations.crossRefs?.length ?? 0), 0);
    console.log(`[ModuleDiscovery] ${totalEdges} cross-module edges total`);
    for (const m of modules) {
      const rel: string[] = [];
      if (m.relations.dependsOn?.length) rel.push(`depends:${m.relations.dependsOn.length}`);
      if (m.relations.produces?.length) rel.push(`produces:${m.relations.produces.length}`);
      if (m.relations.navigatesTo?.length) rel.push(`navTo:${m.relations.navigatesTo.length}`);
      console.log(`  - [${m.kind}] ${m.name} — ${m.componentIds.length} comps, ${m.docSectionIds.length} docs${rel.length ? ', ' + rel.join(',') : ''}`);
    }

    writeFileSync(join(config.outputDir, 'modules.json'), JSON.stringify(modules, null, 2));
    return { modules };
  };
}

// ── Digest ──────────────────────────────────────────────────────────────

function buildDigest(kg: KnowledgeGraph, docs: StructuredDoc[], comp: any): any {
  const pages = kg.pages.map(p => ({ id: p.id, name: p.name, url: p.url }));
  const compsByPage: Record<string, Array<{ id: string; role: string; name: string }>> = {};
  for (const c of kg.components) {
    if (c.disabled || !c.name) continue;
    if (!['button', 'link', 'textbox', 'spinbutton', 'slider', 'switch', 'combobox', 'tab', 'checkbox'].includes(c.role)) continue;
    const k = c.pageId || 'shared';
    (compsByPage[k] = compsByPage[k] || []).push({ id: c.id, role: c.role, name: c.name.slice(0, 50) });
  }
  for (const k of Object.keys(compsByPage)) compsByPage[k] = compsByPage[k].slice(0, 40);

  const docsSummary = docs.slice(0, 20).map(d => ({
    id: d.id,
    title: d.title,
    topics: d.topics,
    rules: d.rules.slice(0, 4),
  }));

  const apis = (kg.apiEndpoints ?? []).slice(0, 30).map((a: any, i: number) => ({
    id: a.id ?? `api:${i}`,
    path: a.path ?? a.url ?? '',
  }));

  const contracts = (kg.contracts ?? []).slice(0, 15).map((c: any) => ({
    address: (c.address ?? '').toLowerCase(),
    role: c.role, name: c.name,
  })).filter((c: any) => c.address);

  const d = {
    dApp: { url: comp?.dappUrl, archetype: comp?.archetype, summary: (comp?.summary ?? '').slice(0, 300) },
    pages, compsByPage, docs: docsSummary, apis, contracts,
    bytes: 0,
  };
  d.bytes = JSON.stringify(d).length;
  return d;
}

// ── LLM ─────────────────────────────────────────────────────────────────

const SYSTEM = [
  'You are a product architect. Identify the business modules of this dApp from crawled primitives + parsed docs.',
  '',
  'Output target: 4–10 modules. Each has:',
  '- id: slug like "module:trade" or "module:connect-wallet"',
  '- name: human label',
  '- kind: "primary" (page-specific user area — Trade, Portfolio, Earn), "cross-cutting" (present on every page — Global Nav, Connect Wallet), or "shared" (referenced by multiple primary modules — e.g. an Asset Selector shared between Trade and Swap)',
  '- description: 1 sentence of what user does here',
  '- businessPurpose: why this module exists',
  '- archetype: perps | swap | lending | staking | cdp | yield | lp | bridge | general',
  '- pageIds: which pages host this module (many-to-many). Cross-cutting modules typically list ALL pages.',
  '- componentIds: DOM atoms assigned to this module (from input compsByPage)',
  '- docSectionIds: docs relevant to this module (from input docs)',
  '- apiEndpointIds: APIs this module uses',
  '- contractAddresses: addresses (0x…) relevant to this module',
  '- relations: cross-module edges:',
  '    dependsOn[]:  modules whose capabilities MUST run first (Trade depends on Connect Wallet)',
  '    produces[]:   {entity, consumedBy: [moduleIds]}  (Trade produces Position, consumed by Portfolio)',
  '    consumedBy[]: inverse of produces',
  '    navigatesTo[]:modules this has controls for opening',
  '    crossRefs[]:  soft references (Referral links back to Trade)',
  '',
  'Hard rules:',
  '- EVERY componentId/docSectionId/apiEndpointId in the output MUST come from the input digest. No inventing ids.',
  '- Every module listed in relations MUST exist in your modules output.',
  '- A cross-cutting module (Global Nav, Connect Wallet) should appear exactly once and list all pages.',
  '- A component can appear in multiple modules (a nav button belongs to Global Nav AND triggers Trade).',
  '',
  'Return STRICT JSON: an array of module objects. No prose. No wrapper.',
].join('\n');

async function askDiscovery(client: ReturnType<typeof createOpenRouterClient>, digest: any): Promise<any[]> {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 6000,
    temperature: 0,
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(digest) }],
  });
  console.log(`[ModuleDiscovery] LLM: in=${resp.usage?.input_tokens}, out=${resp.usage?.output_tokens}, cache_read=${resp.usage?.cache_read_input_tokens ?? 0}`);
  const text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
  return extractJsonArray(text);
}

function extractJsonArray(s: string): any[] {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (fenced ? fenced[1] : s).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return []; }
}

// ── Validation ──────────────────────────────────────────────────────────

function validate(raw: any[], kg: KnowledgeGraph, docs: StructuredDoc[]): DAppModule[] {
  const validCompIds = new Set(kg.components.map(c => c.id));
  const validPageIds = new Set(kg.pages.map(p => p.id));
  const validDocIds = new Set(docs.map(d => d.id));
  const validApiIds = new Set((kg.apiEndpoints ?? []).map((a: any, i: number) => a.id ?? `api:${i}`));
  const validContracts = new Set((kg.contracts ?? []).map((c: any) => (c.address ?? '').toLowerCase()));

  // Pass 1: build cleaned modules (without cross-module edges validated)
  const cleaned: DAppModule[] = [];
  const moduleIds = new Set<string>();
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!m || !m.id || !m.name) continue;
    const kind: ModuleKind = (['primary', 'cross-cutting', 'shared'] as const).includes(m.kind) ? m.kind : 'primary';
    cleaned.push({
      id: String(m.id),
      name: String(m.name),
      kind,
      description: String(m.description ?? '').slice(0, 300),
      businessPurpose: String(m.businessPurpose ?? '').slice(0, 300),
      archetype: m.archetype ? String(m.archetype) : undefined,
      pageIds: filterIds(m.pageIds, validPageIds),
      componentIds: filterIds(m.componentIds, validCompIds),
      controlIds: [],
      docSectionIds: filterIds(m.docSectionIds, validDocIds),
      apiEndpointIds: filterIds(m.apiEndpointIds, validApiIds),
      contractAddresses: (Array.isArray(m.contractAddresses) ? m.contractAddresses : [])
        .map((x: any) => String(x).toLowerCase())
        .filter((x: string) => validContracts.has(x)),
      constraintIds: [],
      relations: {},
    });
    moduleIds.add(String(m.id));
  }

  // Pass 2: validate cross-module edges (module ids must exist)
  for (let i = 0; i < cleaned.length; i++) {
    const raw_m = raw[i];
    const rel = raw_m?.relations ?? {};
    const cm = cleaned[i];
    if (Array.isArray(rel.dependsOn)) cm.relations.dependsOn = rel.dependsOn.filter((x: any) => typeof x === 'string' && moduleIds.has(x));
    if (Array.isArray(rel.navigatesTo)) cm.relations.navigatesTo = rel.navigatesTo.filter((x: any) => typeof x === 'string' && moduleIds.has(x));
    if (Array.isArray(rel.crossRefs)) cm.relations.crossRefs = rel.crossRefs.filter((x: any) => typeof x === 'string' && moduleIds.has(x));
    if (Array.isArray(rel.produces)) {
      cm.relations.produces = rel.produces
        .filter((p: any) => p && typeof p.entity === 'string' && Array.isArray(p.consumedBy))
        .map((p: any) => ({ entity: String(p.entity).slice(0, 80), consumedBy: p.consumedBy.filter((x: any) => moduleIds.has(x)) }))
        .filter((p: any) => p.consumedBy.length > 0);
    }
    if (Array.isArray(rel.consumedBy)) {
      cm.relations.consumedBy = rel.consumedBy
        .filter((p: any) => p && typeof p.entity === 'string' && Array.isArray(p.producedBy))
        .map((p: any) => ({ entity: String(p.entity).slice(0, 80), producedBy: p.producedBy.filter((x: any) => moduleIds.has(x)) }))
        .filter((p: any) => p.producedBy.length > 0);
    }
  }

  return cleaned;
}

function filterIds(input: any, valid: Set<string>): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((x: any) => typeof x === 'string' && valid.has(x));
}

function countBy<T>(arr: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of arr) { const k = key(x); out[k] = (out[k] || 0) + 1; }
  return out;
}

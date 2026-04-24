/**
 * Module Segmenter — LLM pass that groups raw crawl primitives (pages +
 * components + docs + APIs + contracts) into the business-logic modules a
 * human thinks in (Trade, Portfolio, Earn…). Produces `modules.json` + stores
 * the tree on AgentStateType.modules so downstream phases (markdown emitter,
 * spec-gen, agent RAG) read a hierarchy instead of a flat dump.
 *
 * Input: a compact digest (~6-10KB) of the KG + comprehension. Not the full
 * JSONs — just the signals the LLM needs to identify module boundaries.
 *
 * Output contract: DAppModule[] (see src/agent/state.ts). Every id is stable
 * ('module:trade', 'module:trade:zfp'). Every componentId / docSectionId /
 * apiEndpointId in the output MUST exist in the input — hallucination
 * filtering is enforced before write.
 *
 * Cost: one LLM call per pipeline run, ~$0.05-0.15 with Sonnet 4.5.
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../core/llm.js';
import type { AgentStateType, DAppModule, KnowledgeGraph } from '../agent/state.js';

const SEGMENTER_MODEL = process.env.SEGMENTER_MODEL ?? 'anthropic/claude-sonnet-4.5';

// ── Node factory ────────────────────────────────────────────────────────

export function createModuleSegmenterNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { knowledgeGraph: kg, config } = state;
    const compPath = join(config.outputDir, 'comprehension.json');
    const comp = existsSync(compPath) ? JSON.parse(readFileSync(compPath, 'utf-8')) : null;

    console.log('━━━ Module Segmenter: grouping primitives into business modules ━━━');
    const digest = buildDigest(kg, comp);
    console.log(`[ModuleSegmenter] digest: ${digest.bytes} bytes (${digest.pages.length} pages, ${digest.docs.length} docs, ${Object.keys(digest.compsByPage).reduce((n, k) => n + digest.compsByPage[k].length, 0)} components)`);

    const client = createOpenRouterClient(config.apiKey || process.env.OPENROUTER_API_KEY);
    const rawModules = await askSegmenter(client, digest, comp);
    const modules = validateAndClean(rawModules, kg);
    console.log(`[ModuleSegmenter] produced ${modules.length} top-level modules, ${countSubModules(modules)} sub-modules`);
    for (const m of modules) {
      console.log(`  - ${m.name} (${m.archetype ?? 'general'}) — ${m.componentIds.length} components, ${m.docSectionIds.length} docs${m.subModules ? `, ${m.subModules.length} sub-modules` : ''}`);
    }

    writeFileSync(join(config.outputDir, 'modules.json'), JSON.stringify(modules, null, 2));
    return { modules };
  };
}

// ── Digest builder ──────────────────────────────────────────────────────

interface Digest {
  dApp: { name?: string; url?: string; archetype?: string; summary?: string };
  pages: Array<{ id: string; name: string; url: string; elementCount: number }>;
  compsByPage: Record<string, Array<{ id: string; role: string; name: string }>>;
  docs: Array<{ id: string; title: string; keywords: string[]; snippet: string }>;
  apis: Array<{ id: string; path: string }>;
  contracts: Array<{ address: string; role?: string; name?: string }>;
  constraints: Array<{ id: string; summary: string }>;
  primaryFlows?: Array<{ id: string; name: string; entities: string[] }>;
  bytes: number;
}

function buildDigest(kg: KnowledgeGraph, comp: any): Digest {
  const pages = kg.pages.map(p => ({
    id: p.id,
    name: p.name,
    url: p.url,
    elementCount: p.elementCount,
  }));

  const compsByPage: Record<string, Array<{ id: string; role: string; name: string }>> = {};
  for (const c of kg.components) {
    if (c.disabled || !c.name) continue;
    if (!['button', 'link', 'textbox', 'spinbutton', 'slider', 'switch', 'combobox', 'tab', 'checkbox', 'radio'].includes(c.role)) continue;
    const key = c.pageId || 'shared';
    (compsByPage[key] = compsByPage[key] || []).push({
      id: c.id,
      role: c.role,
      name: c.name.slice(0, 60),
    });
  }
  // Cap components per page to avoid bloating
  for (const k of Object.keys(compsByPage)) {
    compsByPage[k] = compsByPage[k].slice(0, 40);
  }

  const docs = (kg.docSections ?? []).slice(0, 20).map((d: any, i: number) => ({
    id: d.id ?? `doc:${i}`,
    title: d.title ?? '(untitled)',
    keywords: (d.keywords ?? []).slice(0, 8),
    snippet: String(d.content ?? d.text ?? '').slice(0, 280),
  }));

  const apis = (kg.apiEndpoints ?? []).slice(0, 40).map((a: any, i: number) => ({
    id: a.id ?? `api:${i}`,
    path: a.path ?? a.url ?? JSON.stringify(a).slice(0, 80),
  }));

  const contracts = (kg.contracts ?? []).slice(0, 15).map((c: any) => ({
    address: (c.address ?? '').toLowerCase(),
    role: c.role,
    name: c.name,
  })).filter(c => c.address);

  const constraints = (kg.constraints ?? []).map((c: any, i: number) => ({
    id: c.id ?? `constraint:${i}`,
    summary: (c.name ?? c.rule ?? '') + (c.value ? ` = ${c.value}` : ''),
  }));

  const primaryFlows = (comp?.primaryFlows ?? []).slice(0, 8).map((f: any) => ({
    id: f.id ?? f.name,
    name: f.name,
    entities: f.entities ?? [],
  }));

  const digest: Digest = {
    dApp: {
      name: comp?.dappName,
      url: comp?.dappUrl,
      archetype: comp?.archetype,
      summary: comp?.summary ? String(comp.summary).slice(0, 400) : undefined,
    },
    pages,
    compsByPage,
    docs,
    apis,
    contracts,
    constraints,
    primaryFlows,
    bytes: 0,
  };
  digest.bytes = JSON.stringify(digest).length;
  return digest;
}

// ── LLM call ────────────────────────────────────────────────────────────

const SEGMENTER_SYSTEM = [
  'You are a product architect. Given a crawled dApp\'s primitives (pages, components, docs, APIs, contracts), identify the business MODULES — the coherent user-facing functional units a PM would bullet on a feature page.',
  '',
  'Target: 4–8 top-level modules per dApp. Not 50. Not 2.',
  '',
  'For each module:',
  '- id: stable slug like "module:trade" or "module:earn:lp-vault"',
  '- name: human display name ("Zero-Fee Perps", "LP Vault")',
  '- description: 1 sentence of what user does here',
  '- businessPurpose: 1 sentence of WHY it exists in the dApp',
  '- archetype: perps | swap | lending | staking | cdp | yield | lp | bridge | general',
  '- pageIds: from input pages[].id',
  '- componentIds: from input compsByPage — which components are part of this module',
  '- docSectionIds: from input docs[].id — which docs describe it',
  '- apiEndpointIds: from input apis[].id — APIs it uses',
  '- contractAddresses: from input contracts[].address',
  '- constraintIds: from input constraints[].id',
  '- triggeredByComponentIds: component ids (from any page) that OPEN this module when clicked (e.g. a "Trade" nav link triggers the Trade module)',
  '- subModules: nested DAppModule[] if there are sub-features (ZFP within Trade, LP Vault within Earn)',
  '',
  'Hard rules:',
  '- Every componentId/docSectionId/apiEndpointId/contractAddress/constraintId MUST exist in the input digest. No inventing ids.',
  '- A component may appear in multiple modules (a nav button belongs to Global AND triggers Trade).',
  '- Sub-modules must be real feature variants (ZFP vs Standard Perps), not arbitrary clustering.',
  '- If there is a cross-cutting "Global / Connect Wallet / Header" module, include it as one top-level entry.',
  '',
  'Return STRICT JSON: an array of top-level DAppModule objects. No markdown, no prose. No JSON wrapper.',
].join('\n');

async function askSegmenter(client: ReturnType<typeof createOpenRouterClient>, digest: Digest, comp: any): Promise<any[]> {
  const userMsg = JSON.stringify(digest, null, 0);
  const resp = await client.messages.create({
    model: SEGMENTER_MODEL,
    max_tokens: 6000,
    temperature: 0,
    system: SEGMENTER_SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
  });
  const text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  console.log(`[ModuleSegmenter] LLM usage: in=${resp.usage?.input_tokens}, out=${resp.usage?.output_tokens}`);
  return extractJsonArray(text);
}

function extractJsonArray(s: string): any[] {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (fenced ? fenced[1] : s).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error(`Segmenter did not return a JSON array: ${body.slice(0, 200)}`);
  return JSON.parse(body.slice(start, end + 1));
}

// ── Validation ──────────────────────────────────────────────────────────

function validateAndClean(raw: any[], kg: KnowledgeGraph): DAppModule[] {
  const validCompIds = new Set(kg.components.map(c => c.id));
  const validPageIds = new Set(kg.pages.map(p => p.id));
  const validDocIds = new Set((kg.docSections ?? []).map((d: any, i: number) => d.id ?? `doc:${i}`));
  const validApiIds = new Set((kg.apiEndpoints ?? []).map((a: any, i: number) => a.id ?? `api:${i}`));
  const validConstraintIds = new Set((kg.constraints ?? []).map((c: any, i: number) => c.id ?? `constraint:${i}`));
  const validContracts = new Set((kg.contracts ?? []).map((c: any) => (c.address ?? '').toLowerCase()));

  function clean(m: any, parentId?: string): DAppModule {
    const id = typeof m.id === 'string' && m.id ? m.id : `module:${slug(m.name ?? 'unknown')}`;
    return {
      id,
      name: String(m.name ?? 'Unnamed'),
      parentId,
      description: String(m.description ?? '').slice(0, 300),
      businessPurpose: String(m.businessPurpose ?? '').slice(0, 300),
      archetype: m.archetype ? String(m.archetype) : undefined,
      pageIds: filterIds(m.pageIds, validPageIds),
      componentIds: filterIds(m.componentIds, validCompIds),
      docSectionIds: filterIds(m.docSectionIds, validDocIds),
      apiEndpointIds: filterIds(m.apiEndpointIds, validApiIds),
      contractAddresses: (Array.isArray(m.contractAddresses) ? m.contractAddresses : [])
        .map((x: any) => String(x).toLowerCase())
        .filter((x: string) => validContracts.has(x)),
      constraintIds: filterIds(m.constraintIds, validConstraintIds),
      triggeredByComponentIds: filterIds(m.triggeredByComponentIds, validCompIds),
      subModules: Array.isArray(m.subModules) && m.subModules.length > 0
        ? m.subModules.map((sm: any) => clean(sm, id))
        : undefined,
    };
  }

  return (Array.isArray(raw) ? raw : []).map((m: any) => clean(m));
}

function filterIds(input: any, valid: Set<string>): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((x: any) => typeof x === 'string' && valid.has(x));
}

function slug(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'm';
}

function countSubModules(modules: DAppModule[]): number {
  let n = 0;
  for (const m of modules) {
    if (m.subModules) { n += m.subModules.length + countSubModules(m.subModules); }
  }
  return n;
}

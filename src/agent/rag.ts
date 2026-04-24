/**
 * RAG retrieval — filename-based lookup from URL/module-name → module .md.
 *
 * No vector search, no embeddings. Modules are discrete + few (~5-15 per dApp),
 * so a slug table is both sufficient and 100% deterministic. The executor calls
 * this to load current-module context when navigating, and the agent can call
 * `get_module_context` as a tool for explicit retrieval.
 *
 * Resolution order:
 *   1. Exact slug match (e.g. `trade`, `trade.zfp`, `earn.lp-vault`)
 *   2. Module name match (case-insensitive, normalized)
 *   3. URL path match — compare against every module's pageIds
 *   4. Substring match on name/slug
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { activeDApp, outputDir, type ActiveDApp } from '../config.js';
import type { DAppModule } from './state.js';

export interface RagHit {
  moduleId: string;
  moduleName: string;
  slug: string;
  bytes: number;
  content: string;
}

interface RagIndex {
  modules: DAppModule[];
  flattened: DAppModule[];
  byId: Map<string, DAppModule>;
  bySlug: Map<string, DAppModule>;
  byNameNorm: Map<string, DAppModule>;
}

let cache: { hostDir: string; index: RagIndex } | null = null;

function loadIndex(dapp: ActiveDApp): RagIndex | null {
  if (cache && cache.hostDir === dapp.hostDir) return cache.index;
  const path = join(outputDir(dapp), 'modules.json');
  if (!existsSync(path)) return null;
  let modules: DAppModule[];
  try { modules = JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
  const flattened = flatten(modules);
  const byId = new Map<string, DAppModule>();
  const bySlug = new Map<string, DAppModule>();
  const byNameNorm = new Map<string, DAppModule>();
  for (const m of flattened) {
    byId.set(m.id, m);
    bySlug.set(slugFor(m.id), m);
    byNameNorm.set(normalizeName(m.name), m);
  }
  const index: RagIndex = { modules, flattened, byId, bySlug, byNameNorm };
  cache = { hostDir: dapp.hostDir, index };
  return index;
}

function flatten(modules: DAppModule[]): DAppModule[] {
  const out: DAppModule[] = [];
  const walk = (ms: DAppModule[]) => { for (const m of ms) { out.push(m); if (m.subModules?.length) walk(m.subModules); } };
  walk(modules);
  return out;
}

function slugFor(moduleId: string): string {
  return moduleId.replace(/^module:/, '').replace(/:/g, '.');
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

function urlPath(url?: string): string {
  if (!url) return '';
  try { return new URL(url).pathname; } catch { return url; }
}

// ── Public API ──────────────────────────────────────────────────────────

/** Thin overview — loaded once at session start. Lists dApp + all modules. */
export function overviewBlock(dapp: ActiveDApp = activeDApp()): string {
  const indexPath = join(outputDir(dapp), 'knowledge', 'index.md');
  if (existsSync(indexPath)) {
    try { return readFileSync(indexPath, 'utf-8'); } catch {}
  }
  // Fallback if no index.md yet
  return `# ${dapp.name}\nURL: ${dapp.url}\nArchetype: ${dapp.archetype}\nChain: ${dapp.chain.name} (${dapp.chain.id})`;
}

/** Resolve a hint (URL, module name, or slug) to the best matching module's .md content. */
export function getModuleContext(
  hint: { page_url?: string; module_name?: string; slug?: string },
  dapp: ActiveDApp = activeDApp(),
): RagHit | null {
  const idx = loadIndex(dapp);
  if (!idx) return null;

  let m: DAppModule | undefined;

  // 1) explicit slug
  if (hint.slug) m = idx.bySlug.get(hint.slug);

  // 2) module name
  if (!m && hint.module_name) {
    m = idx.byNameNorm.get(normalizeName(hint.module_name));
  }

  // 3) URL path match — first module with this path in pageIds
  if (!m && hint.page_url) {
    const path = urlPath(hint.page_url);
    m = idx.flattened.find(x => x.pageIds.some(pid => pid.includes(path) || path.includes(pid.replace(/^page:/, ''))));
  }

  // 4) substring on name or slug
  if (!m) {
    const needle = (hint.module_name ?? hint.slug ?? hint.page_url ?? '').toLowerCase();
    if (needle) {
      m = idx.flattened.find(x =>
        x.name.toLowerCase().includes(needle) || slugFor(x.id).includes(needle),
      );
    }
  }

  if (!m) return null;
  return loadMd(m, dapp);
}

/** Pull all modules matching a URL (supports multi-module pages). */
export function getModulesByUrl(url: string, dapp: ActiveDApp = activeDApp()): RagHit[] {
  const idx = loadIndex(dapp);
  if (!idx) return [];
  const path = urlPath(url);
  const matches = idx.flattened.filter(m =>
    m.pageIds.some(pid => {
      const stripped = pid.replace(/^page:/, '');
      return stripped === path || stripped === url || (path && stripped.includes(path));
    }),
  );
  return matches.map(m => loadMd(m, dapp)).filter((x): x is RagHit => !!x);
}

function loadMd(m: DAppModule, dapp: ActiveDApp): RagHit | null {
  const slug = slugFor(m.id);
  const path = join(outputDir(dapp), 'knowledge', `${slug}.md`);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf-8');
  return { moduleId: m.id, moduleName: m.name, slug, bytes: content.length, content };
}

/** List every available module (used by get_module_context when hint is missing). */
export function listModules(dapp: ActiveDApp = activeDApp()): Array<{ id: string; slug: string; name: string; archetype?: string }> {
  const idx = loadIndex(dapp);
  if (!idx) return [];
  return idx.flattened.map(m => ({ id: m.id, slug: slugFor(m.id), name: m.name, archetype: m.archetype }));
}

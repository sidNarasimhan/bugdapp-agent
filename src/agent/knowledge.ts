/**
 * Knowledge surface for the executor agent.
 *
 * BEFORE (Phase ≤A): dumped 6-8KB of flat KG (components per page + doc
 * snippets + constraints + existing specs menu) into every system prompt.
 *
 * NOW (Phase B): thin base (<500B — dApp id + module index reference) +
 * on-demand retrieval via src/agent/rag.ts. The agent gets:
 *   - overviewBlock: the knowledge/index.md listing module slugs, loaded once
 *   - on browser_navigate: auto-injected current-page module .md (via RAG)
 *   - get_module_context tool: explicit retrieval by page_url / module_name / slug
 *
 * Research backing: GraphRAG 72-83% comprehensiveness win at 26-97% fewer
 * tokens; Anthropic Contextual Retrieval 49-67% retrieval-failure reduction;
 * KGoT 3.2x cheaper than flat-context agents at higher accuracy.
 */
import { overviewBlock, getModulesByUrl, listModules, getModuleContext, type RagHit } from './rag.js';
import type { ActiveDApp } from '../config.js';

export interface ThinKnowledge {
  /** Session-start base — dApp id + module index. ~400-800B. */
  overview: string;
  /** Number of modules available for on-demand retrieval. */
  moduleCount: number;
}

export function thinKnowledge(dapp: ActiveDApp): ThinKnowledge {
  const overview = overviewBlock(dapp);
  const modules = listModules(dapp);
  return { overview, moduleCount: modules.length };
}

/** Pull the RAG hit for the agent's current page — called by loop.ts auto-inject. */
export function contextForUrl(url: string, dapp: ActiveDApp): RagHit[] {
  return getModulesByUrl(url, dapp);
}

/** Explicit resolver for the `get_module_context` tool. */
export function resolveModuleContext(
  hint: { page_url?: string; module_name?: string; slug?: string },
  dapp: ActiveDApp,
): RagHit | null {
  return getModuleContext(hint, dapp);
}

// Re-export for convenience
export { listModules } from './rag.js';

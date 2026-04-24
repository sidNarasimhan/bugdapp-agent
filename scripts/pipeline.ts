#!/usr/bin/env npx tsx
/**
 * Full pipeline runner — builds the agent's brain for a dApp from scratch.
 *
 *   npm run pipeline -- --url https://developer.avantisfi.com/trade
 *
 * Phases (capability-centric rebuild):
 *   1. Crawler              browser crawl of site + docs + APIs
 *   2. KG Builder           typed graph from crawl (no LLM)
 *   3. Comprehender         LLM archetype + overall summary (optional, reused)
 *   4. Doc Structurer       LLM: parse each doc → {topics, rules}
 *   5. Module Discovery     LLM: primary/cross-cutting/shared modules + cross-module edges
 *   6. Control Clustering   LLM: DOM atoms → semantic Controls
 *   7. Control Wiring       LLM: feedsInto/gates/affectedBy edges
 *   8. Capability Derivation (no LLM) graph traversal → capabilities
 *   9. Capability Naming    LLM: name each graph-derived capability
 *  10. Edge Case Derivation (no LLM) constraints × capabilities → edge cases
 *  11. Persona Assignment   LLM: tag capabilities with personas
 *  12. Explorer (agent)     drives browser per module to validate/enrich
 *  13. Markdown Emitter     no LLM — writes knowledge/*.md from all phases
 *  14. Spec Gen             no LLM — one spec per capability × edge case
 *
 * Skip flags let you reuse cached artifacts:
 *   --skip-crawl --skip-comprehend --skip-docs --skip-modules
 *   --skip-controls --skip-wiring --skip-capabilities --skip-naming
 *   --skip-edges --skip-personas --skip-explore --skip-markdown --skip-specgen
 */
import 'dotenv/config';
import { mkdirSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { launchBrowser, closeBrowser } from '../src/core/browser-launch.js';
import { createCrawlerNode, loadCachedCrawlAndKG } from '../src/pipeline/crawler.js';
import { createKGBuilderNode } from '../src/pipeline/kg-builder.js';
import { createComprehensionNode } from '../src/pipeline/comprehender.js';
import { createDocStructurerNode } from '../src/pipeline/doc-structurer.js';
import { createModuleDiscoveryNode } from '../src/pipeline/module-discovery.js';
import { createControlClusteringNode } from '../src/pipeline/control-clustering.js';
import { createControlWiringNode } from '../src/pipeline/control-wiring.js';
import { createCapabilityDerivationNode } from '../src/pipeline/capability-derivation.js';
import { createCapabilityNamingNode } from '../src/pipeline/capability-naming.js';
import { createEdgeCaseDerivationNode } from '../src/pipeline/edge-case-derivation.js';
import { createPersonaAssignmentNode } from '../src/pipeline/persona-assignment.js';
import { createMarkdownEmitterNode } from '../src/pipeline/markdown-emitter.js';
import { createComprehensionSpecGenNode } from '../src/pipeline/spec-gen.js';
import { activeDApp } from '../src/config.js';
import { emptyKnowledgeGraph } from '../src/agent/state.js';
import type { AgentStateType } from '../src/agent/state.js';

function flag(name: string): boolean { return process.argv.includes(`--${name}`); }
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = arg('url') ?? process.env.DAPP_URL ?? 'https://developer.avantisfi.com/trade';
  const dapp = activeDApp();
  const outputDir = join(process.cwd(), 'output', (() => { try { return new URL(url).hostname.replace(/\./g, '-'); } catch { return url; } })());
  mkdirSync(outputDir, { recursive: true });

  // Copy fixtures so generated specs run out of the box
  const fixturesDir = join(outputDir, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  copyFileSync(join(process.cwd(), 'templates', 'wallet.fixture.ts'), join(fixturesDir, 'wallet.fixture.ts'));
  if (!existsSync(join(outputDir, 'playwright.config.ts'))) {
    copyFileSync(join(process.cwd(), 'templates', 'playwright.config.ts'), join(outputDir, 'playwright.config.ts'));
  }

  const started = Date.now();
  const state: AgentStateType = {
    messages: [],
    knowledgeGraph: emptyKnowledgeGraph(),
    graph: { nodes: [], edges: [] },
    crawlData: null,
    testPlan: null,
    specFiles: [],
    testResults: [],
    iteration: 0,
    maxIterations: 3,
    config: {
      url,
      seedPhrase: process.env.SEED_PHRASE ?? '',
      apiKey: process.env.OPENROUTER_API_KEY ?? '',
      outputDir,
      headless: false,
      explorerModel: process.env.EXECUTOR_MODEL ?? 'anthropic/claude-sonnet-4.5',
      plannerModel: process.env.PLANNER_MODEL ?? 'deepseek/deepseek-chat',
      generatorModel: process.env.GENERATOR_MODEL ?? 'deepseek/deepseek-chat',
      healerModel: process.env.EXECUTOR_MODEL ?? 'anthropic/claude-sonnet-4.5',
    },
  };

  console.log(`━━━ Pipeline for ${dapp.name} (${url}) ━━━`);
  console.log(`Output: ${outputDir}`);

  // Phase 1 — Crawler
  if (!flag('skip-crawl')) {
    console.log('\n━━━ Phase 1: Crawler ━━━');
    const browserCtx = await launchBrowser({
      seedPhrase: state.config.seedPhrase,
      headless: false,
      screenshotDir: join(outputDir, 'screenshots'),
      metamaskPath: process.env.METAMASK_PATH,
    });
    try {
      const crawler = createCrawlerNode(browserCtx);
      Object.assign(state, await crawler(state));
    } finally {
      await closeBrowser(browserCtx);
    }
  } else {
    console.log('[pipeline] --skip-crawl: loading cached crawl from disk');
    const cached = loadCachedCrawlAndKG(outputDir, url);
    if (!cached) {
      console.error('[pipeline] --skip-crawl requires cached context.json + scraped-data.json on disk; none found. Aborting.');
      process.exit(1);
    }
    state.crawlData = cached.crawlData;
    state.knowledgeGraph = cached.knowledgeGraph;
    console.log(`[pipeline] cached KG: ${cached.knowledgeGraph.pages.length} pages, ${cached.knowledgeGraph.components.length} components, ${cached.knowledgeGraph.docSections?.length ?? 0} docs`);
  }

  // Phase 2 — KG Builder
  console.log('\n━━━ Phase 2: KG Builder ━━━');
  Object.assign(state, await createKGBuilderNode()(state));

  // Phase 3 — Comprehender
  if (!flag('skip-comprehend')) {
    console.log('\n━━━ Phase 3: Comprehender ━━━');
    Object.assign(state, await createComprehensionNode()(state));
  } else {
    console.log('[pipeline] --skip-comprehend');
  }

  // Phase 4 — Doc Structurer
  if (!flag('skip-docs')) {
    console.log('\n━━━ Phase 4: Doc Structurer ━━━');
    Object.assign(state, await createDocStructurerNode()(state));
  } else {
    console.log('[pipeline] --skip-docs');
  }

  // Phase 5 — Module Discovery
  if (!flag('skip-modules')) {
    console.log('\n━━━ Phase 5: Module Discovery ━━━');
    Object.assign(state, await createModuleDiscoveryNode()(state));
  } else {
    console.log('[pipeline] --skip-modules');
  }

  // Phase 6 — Control Clustering
  if (!flag('skip-controls')) {
    console.log('\n━━━ Phase 6: Control Clustering ━━━');
    Object.assign(state, await createControlClusteringNode()(state));
  } else {
    console.log('[pipeline] --skip-controls');
  }

  // Phase 7 — Control Wiring
  if (!flag('skip-wiring')) {
    console.log('\n━━━ Phase 7: Control Wiring ━━━');
    Object.assign(state, await createControlWiringNode()(state));
  } else {
    console.log('[pipeline] --skip-wiring');
  }

  // Phase 8 — Capability Derivation (no LLM)
  if (!flag('skip-capabilities')) {
    console.log('\n━━━ Phase 8: Capability Derivation ━━━');
    Object.assign(state, await createCapabilityDerivationNode()(state));
  } else {
    console.log('[pipeline] --skip-capabilities');
  }

  // Phase 9 — Capability Naming (LLM labels)
  if (!flag('skip-naming')) {
    console.log('\n━━━ Phase 9: Capability Naming ━━━');
    Object.assign(state, await createCapabilityNamingNode()(state));
  } else {
    console.log('[pipeline] --skip-naming');
  }

  // Phase 10 — Edge Case Derivation (no LLM)
  if (!flag('skip-edges')) {
    console.log('\n━━━ Phase 10: Edge Case Derivation ━━━');
    Object.assign(state, await createEdgeCaseDerivationNode()(state));
  } else {
    console.log('[pipeline] --skip-edges');
  }

  // Phase 11 — Persona Assignment
  if (!flag('skip-personas')) {
    console.log('\n━━━ Phase 11: Persona Assignment ━━━');
    Object.assign(state, await createPersonaAssignmentNode()(state));
  } else {
    console.log('[pipeline] --skip-personas');
  }

  // Phase 12 — Markdown Emit (no LLM)
  if (!flag('skip-markdown')) {
    console.log('\n━━━ Phase 12: Markdown Emitter ━━━');
    await createMarkdownEmitterNode()(state);
  } else {
    console.log('[pipeline] --skip-markdown');
  }

  // Phase 13 — Explorer (agent, per module)
  if (!flag('skip-explore') && !flag('skip-explorer')) {
    console.log('\n━━━ Phase 13: Explorer (agent, per module) ━━━');
    const { explore } = await import('../src/pipeline/explorer.js');
    const out = await explore();
    console.log(`[explorer] ${out.modulesExplored} modules explored · ${(out.totalDurationMs / 1000).toFixed(1)}s · ${Math.round(out.totalTokens / 1000)}k tok`);
    // Re-emit markdown in case explorer updated anything (currently it doesn't mutate state, but future enhancement)
    if (!flag('skip-markdown-reemit')) {
      console.log('\n━━━ Phase 13b: Markdown Re-emit (post-explorer) ━━━');
      await createMarkdownEmitterNode()(state);
    }
  } else {
    console.log('[pipeline] --skip-explore');
  }

  // Phase 14 — Spec Gen (no LLM)
  if (!flag('skip-specgen')) {
    console.log('\n━━━ Phase 14: Spec Generator ━━━');
    Object.assign(state, await createComprehensionSpecGenNode()(state));
  } else {
    console.log('[pipeline] --skip-specgen');
  }

  console.log(`\n━━━ Done in ${((Date.now() - started) / 1000).toFixed(1)}s ━━━`);
  console.log(`Artifacts: ${outputDir}`);
  console.log(`Modules: ${state.modules?.length ?? 0}`);
  console.log(`Controls: ${state.controls?.length ?? 0}`);
  console.log(`Capabilities: ${state.capabilities?.length ?? 0}`);
  console.log(`Specs: ${state.specFiles.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });

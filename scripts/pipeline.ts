#!/usr/bin/env npx tsx
/**
 * Full pipeline runner — builds the agent's brain for a dApp from scratch.
 *
 *   npm run pipeline -- --url https://developer.avantisfi.com
 *
 * Phases (all in-process, no subprocess fan-out):
 *   1. Crawler      crawl site, docs, APIs              → context + raw KG
 *   2. KG Builder   typed graph edges                   → graph.json
 *   3. Comprehender LLM archetype + flows + constraints → comprehension.json
 *   4. Spec Gen     module-by-module Playwright specs   → tests/*.spec.ts + fixtures/
 *
 * Skip flags to reuse cached artifacts (cheap re-runs):
 *   --skip-crawl      reuse output/<host>/{context,scraped-data}.json
 *   --skip-comprehend reuse comprehension.json
 *   --skip-specgen    reuse tests/*.spec.ts
 */
import 'dotenv/config';
import { mkdirSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { launchBrowser, closeBrowser } from '../src/core/browser-launch.js';
import { createCrawlerNode } from '../src/pipeline/crawler.js';
import { createKGBuilderNode } from '../src/pipeline/kg-builder.js';
import { createComprehensionNode } from '../src/pipeline/comprehender.js';
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

  // Phase 1 — Crawler (needs browser)
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
      const patch = await crawler(state);
      Object.assign(state, patch);
    } finally {
      await closeBrowser(browserCtx);
    }
  } else {
    console.log('[pipeline] skipping crawl — reusing cached context.json');
  }

  // Phase 2 — KG Builder (no LLM, no browser)
  console.log('\n━━━ Phase 2: KG Builder ━━━');
  const kgBuilder = createKGBuilderNode();
  Object.assign(state, await kgBuilder(state));

  // Phase 3 — Comprehender (LLM) — runs before segmenter so segmenter has archetype/summary context
  if (!flag('skip-comprehend')) {
    console.log('\n━━━ Phase 3: Comprehender ━━━');
    const comp = createComprehensionNode();
    Object.assign(state, await comp(state));
  } else {
    console.log('[pipeline] skipping comprehend — reusing cached comprehension.json');
  }

  // Phase 4 — Module Segmenter (LLM) — identifies business modules + links to docs/APIs/components
  if (!flag('skip-segment')) {
    console.log('\n━━━ Phase 4: Module Segmenter ━━━');
    const { createModuleSegmenterNode } = await import('../src/pipeline/module-segmenter.js');
    const seg = createModuleSegmenterNode();
    Object.assign(state, await seg(state));
  } else {
    console.log('[pipeline] skipping module-segmenter — reusing cached modules.json');
  }

  // Phase 5 — Markdown Emitter (no LLM) — writes knowledge/*.md for RAG
  if (!flag('skip-markdown')) {
    console.log('\n━━━ Phase 5: Markdown Emitter ━━━');
    const { createMarkdownEmitterNode } = await import('../src/pipeline/markdown-emitter.js');
    const md = createMarkdownEmitterNode();
    Object.assign(state, await md(state));
  }

  // Phase 6 — Explorer (agent-driven, module-by-module KG enrichment)
  if (!flag('skip-explore') && !flag('skip-explorer')) {
    console.log('\n━━━ Phase 6: Explorer (agent-driven, per module) ━━━');
    const { explore } = await import('../src/pipeline/explorer.js');
    const out = await explore();
    console.log(`[explorer] ${out.modulesExplored} modules explored · ${(out.totalDurationMs/1000).toFixed(1)}s · ${Math.round(out.totalTokens/1000)}k tok`);
  } else {
    console.log('[pipeline] skipping explore');
  }

  // Phase 7 — Persona Mapper (LLM) — per-module user flows grouped by persona
  if (!flag('skip-persona')) {
    console.log('\n━━━ Phase 7: Persona Mapper ━━━');
    const { createPersonaMapperNode } = await import('../src/pipeline/persona-mapper.js');
    const pm = createPersonaMapperNode();
    Object.assign(state, await pm(state));
  } else {
    console.log('[pipeline] skipping persona-mapper — reusing cached flows-by-persona.json');
  }

  // Phase 8 — Spec Gen (no LLM, deterministic)
  if (!flag('skip-specgen')) {
    console.log('\n━━━ Phase 8: Spec Generator ━━━');
    const sg = createComprehensionSpecGenNode();
    Object.assign(state, await sg(state));
  } else {
    console.log('[pipeline] skipping spec-gen — reusing tests/*.spec.ts');
  }

  console.log(`\n━━━ Done in ${((Date.now() - started) / 1000).toFixed(1)}s ━━━`);
  console.log(`Artifacts: ${outputDir}`);
  console.log(`Generated ${state.specFiles.length} spec file(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });

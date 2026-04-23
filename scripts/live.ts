#!/usr/bin/env npx tsx
/**
 * Single-command live runner. Orchestrates the full loop:
 *
 *   crawler  →  comprehension  →  comprehension-spec-gen  →  outreach report
 *
 * Usage:
 *   npx tsx scripts/live.ts <url>                     full loop
 *   npx tsx scripts/live.ts <url> --skip-crawl        reuse cached crawl (requires context.json)
 *   npx tsx scripts/live.ts <url> --skip-comprehend   reuse cached comprehension.json
 *   npx tsx scripts/live.ts <url> --skip-specs        reuse generated specs
 *   npx tsx scripts/live.ts <url> --skip-outreach     don't write OUTREACH.md
 *   npx tsx scripts/live.ts <url> --force             bust all caches, regenerate everything
 *
 * Each phase prints a progress marker + measured count so the caller can see
 * what actually happened end-to-end. Idempotent when re-run: skipped phases
 * reuse on-disk artifacts.
 */
import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';

interface Args {
  url: string;
  skipCrawl: boolean;
  skipComprehend: boolean;
  skipSpecs: boolean;
  skipOutreach: boolean;
  force: boolean;
  runSuite: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const positional = argv.filter(a => !a.startsWith('--'));
  if (positional.length === 0) {
    console.error('Usage: tsx scripts/live.ts <url> [--skip-crawl|--skip-comprehend|--skip-specs|--skip-outreach|--force|--run-suite]');
    process.exit(1);
  }
  return {
    url: positional[0],
    skipCrawl: argv.includes('--skip-crawl'),
    skipComprehend: argv.includes('--skip-comprehend'),
    skipSpecs: argv.includes('--skip-specs'),
    skipOutreach: argv.includes('--skip-outreach'),
    force: argv.includes('--force'),
    runSuite: argv.includes('--run-suite'),
  };
}

function urlToHostDir(url: string): string {
  try { return new URL(url).hostname.replace(/\./g, '-'); } catch { return url; }
}

function banner(step: number, total: number, name: string) {
  const bar = '━'.repeat(50);
  console.log(`\n${bar}\nStep ${step}/${total}: ${name}\n${bar}`);
}

function readJsonIfExists(path: string): any | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

async function main() {
  const args = parseArgs();
  const host = urlToHostDir(args.url);
  const outputDir = join(process.cwd(), 'output', host);
  mkdirSync(outputDir, { recursive: true });

  const totalSteps = args.runSuite ? 5 : 4;
  const started = Date.now();

  console.log(`━━━ bugdapp-agent live runner ━━━`);
  console.log(`URL:       ${args.url}`);
  console.log(`Host:      ${host}`);
  console.log(`Output:    ${outputDir}`);
  console.log(`Flags:     crawl=${!args.skipCrawl} comprehend=${!args.skipComprehend} specs=${!args.skipSpecs} outreach=${!args.skipOutreach} force=${args.force} run-suite=${args.runSuite}`);

  // Step 1: crawler → KG (via existing run-pipeline.ts with --stop-after kg_builder)
  banner(1, totalSteps, 'Crawler + KG builder');
  if (args.force) {
    for (const f of ['context.json', 'scraped-data.json']) {
      const p = join(outputDir, f);
      if (existsSync(p)) unlinkSync(p);
    }
  }
  if (args.skipCrawl && existsSync(join(outputDir, 'context.json'))) {
    console.log('[live] --skip-crawl: reusing cached crawl');
    // Still need to regenerate KG from cached data (fast, deterministic).
    const { createCrawlerNode } = await import('../src/agent/nodes/crawler.js');
    const node = createCrawlerNode(null as any);
    const res = await node({
      messages: [], knowledgeGraph: undefined as any, graph: { nodes: [], edges: [] },
      crawlData: null, testPlan: null, specFiles: [], testResults: [],
      iteration: 0, maxIterations: 3,
      config: {
        url: args.url, outputDir, headless: true,
        seedPhrase: '', apiKey: process.env.OPENROUTER_API_KEY || '',
        explorerModel: '', plannerModel: '', generatorModel: '', healerModel: '',
      },
    } as any) as any;
    const kg = res.knowledgeGraph;
    writeFileSync(join(outputDir, 'knowledge-graph.json'), JSON.stringify(kg, null, 2));
    console.log(`[live] KG rebuilt from cache: ${kg.pages?.length ?? 0} pages / ${kg.components?.length ?? 0} components / ${kg.contracts?.length ?? 0} contracts`);
  } else if (!args.skipCrawl) {
    // Real crawl — delegate to run-pipeline.ts which handles browser + MM.
    console.log('[live] running real crawl via scripts/run-pipeline.ts');
    const child = await execa('npx', [
      'tsx', 'scripts/run-pipeline.ts',
      '--url', args.url,
      '--skip-explorer',
      '--stop-after', 'kg_builder',
    ], {
      cwd: process.cwd(), env: process.env, stdio: 'inherit', reject: false,
      timeout: 25 * 60 * 1000,
    });
    if (child.exitCode !== 0) {
      console.error(`[live] crawler exited ${child.exitCode} — continuing with whatever made it to disk`);
    }
  } else {
    console.log('[live] --skip-crawl + no cached crawl — nothing to do; skipping');
  }

  // Step 2: comprehension
  banner(2, totalSteps, 'Comprehension (LLM reasoning)');
  if (args.force || !args.skipComprehend) {
    const compPath = join(outputDir, 'comprehension.json');
    if (args.force && existsSync(compPath)) unlinkSync(compPath);
    try {
      const child = await execa('npx', ['tsx', 'scripts/run-comprehension.ts', host], {
        cwd: process.cwd(), env: process.env, stdio: 'inherit', reject: false,
        timeout: 10 * 60 * 1000,
      });
      if (child.exitCode !== 0) {
        console.warn(`[live] comprehension exited ${child.exitCode} — continuing`);
      }
    } catch (e) {
      console.warn(`[live] comprehension failed: ${(e as Error).message}`);
    }
  } else {
    console.log('[live] --skip-comprehend: reusing cached comprehension.json');
  }

  // Step 3: spec generation from comprehension
  banner(3, totalSteps, 'Comprehension-driven spec generation');
  if (args.force || !args.skipSpecs) {
    const { createComprehensionSpecGenNode } = await import('../src/agent/nodes/comprehension-spec-gen.js');
    const node = createComprehensionSpecGenNode();
    const res = await node({
      messages: [], knowledgeGraph: undefined as any, graph: { nodes: [], edges: [] },
      crawlData: null, testPlan: null, specFiles: [], testResults: [],
      iteration: 0, maxIterations: 3,
      config: {
        url: args.url, outputDir, headless: true,
        seedPhrase: '', apiKey: process.env.OPENROUTER_API_KEY || '',
        explorerModel: '', plannerModel: '', generatorModel: '', healerModel: '',
      },
    } as any) as any;
    console.log(`[live] generated ${res.specFiles?.length ?? 0} spec files`);
  } else {
    console.log('[live] --skip-specs: reusing generated specs on disk');
  }

  // Step 4: outreach report
  banner(4, totalSteps, 'Outreach report');
  if (!args.skipOutreach) {
    const child = await execa('npx', ['tsx', 'scripts/make-outreach-report.ts', host], {
      cwd: process.cwd(), env: process.env, stdio: 'inherit', reject: false,
      timeout: 60 * 1000,
    });
    if (child.exitCode !== 0) console.warn(`[live] outreach report exited ${child.exitCode}`);
  } else {
    console.log('[live] --skip-outreach: not writing OUTREACH.md');
  }

  // Step 5 (optional): run the suite — headful Playwright + agent self-heal on failures
  if (args.runSuite) {
    banner(5, totalSteps, 'Run generated suite (self-healing)');
    const testsDir = join(outputDir, 'tests');
    if (!existsSync(testsDir)) {
      console.warn(`[live] no tests directory at ${testsDir} — skipping`);
    } else {
      const { runSuiteWithHealing, formatHealSummary } = await import('../src/chat/agent/heal-runner.js');
      const summary = await runSuiteWithHealing({
        dAppUrl: args.url,
        outputDir,
        verifyAfterHeal: true,
        onLine: (l) => console.log(l),
      });
      console.log('\n' + formatHealSummary(summary));
    }
  }

  // Final summary
  const comp = readJsonIfExists(join(outputDir, 'comprehension.json'));
  const kg = readJsonIfExists(join(outputDir, 'knowledge-graph.json'));
  const outreach = existsSync(join(outputDir, 'OUTREACH.md'));

  console.log(`\n━━━ Summary ━━━`);
  console.log(`Elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (comp) console.log(`Archetype: ${comp.archetype} (conf ${comp.archetypeConfidence})`);
  if (kg) console.log(`KG: ${kg.pages?.length ?? 0} pages / ${kg.components?.length ?? 0} components / ${kg.docSections?.length ?? 0} doc sections / ${kg.contracts?.length ?? 0} contracts`);
  console.log(`Comprehension: ${comp ? 'yes' : 'no'}`);
  console.log(`Outreach report: ${outreach ? join(outputDir, 'OUTREACH.md') : 'no'}`);
  console.log(`Artifacts dir: ${outputDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });

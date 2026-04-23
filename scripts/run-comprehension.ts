#!/usr/bin/env npx tsx
/**
 * Run comprehension node on cached crawl data for a single dApp or a batch.
 *
 * Usage:
 *   npx tsx scripts/run-comprehension.ts <hostname>                  # run one, overwrite if cached
 *   npx tsx scripts/run-comprehension.ts --all                       # run all 5 real-KG dApps
 *   npx tsx scripts/run-comprehension.ts --all --force               # regenerate even if cached
 */
import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const DEFAULT_DAPPS = [
  'developer-avantisfi-com',
  'app-aave-com',
  'aerodrome-finance',
  'app-morpho-org',
  'app-compound-finance',
];

async function runOne(host: string, force: boolean): Promise<{ host: string; ok: boolean; archetype?: string; flows?: number; confidence?: number; error?: string }> {
  const outputDir = join(process.cwd(), 'output', host);
  if (!existsSync(join(outputDir, 'context.json'))) {
    return { host, ok: false, error: 'no cached crawl' };
  }

  if (force) {
    const p = join(outputDir, 'comprehension.json');
    if (existsSync(p)) unlinkSync(p);
  }

  // Load cached KG + crawlData.
  const { createCrawlerNode } = await import('../src/agent/nodes/crawler.js');
  const { createComprehensionNode } = await import('../src/agent/nodes/comprehension.js');

  const ctx = JSON.parse(readFileSync(join(outputDir, 'context.json'), 'utf-8'));
  const url = ctx.url || `https://${host.replace(/-/g, '.')}`;

  const config = {
    url, outputDir, headless: true,
    seedPhrase: '', apiKey: process.env.OPENROUTER_API_KEY || '',
    explorerModel: 'deepseek/deepseek-chat-v3-0324',
    plannerModel: 'deepseek/deepseek-chat-v3-0324',
    generatorModel: 'qwen/qwen3-coder',
    healerModel: 'qwen/qwen3-coder',
  };

  // Build KG from cache.
  const crawlerNode = createCrawlerNode(null as any);
  const crawlerResult = await crawlerNode({
    messages: [], knowledgeGraph: undefined as any, graph: { nodes: [], edges: [] },
    crawlData: null, testPlan: null, specFiles: [], testResults: [],
    iteration: 0, maxIterations: 3, config,
  } as any) as any;

  // Run comprehension.
  const compNode = createComprehensionNode();
  try {
    const out = await compNode({
      messages: [], knowledgeGraph: crawlerResult.knowledgeGraph, graph: { nodes: [], edges: [] },
      crawlData: crawlerResult.crawlData, testPlan: null, specFiles: [], testResults: [],
      iteration: 0, maxIterations: 3, config,
    } as any) as any;
    const c = out.comprehension;
    return {
      host,
      ok: true,
      archetype: c.archetype,
      flows: c.primaryFlows.length,
      confidence: c.archetypeConfidence,
    };
  } catch (e) {
    return { host, ok: false, error: (e as Error).message };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const all = argv.includes('--all');
  const hosts = all ? DEFAULT_DAPPS : argv.filter(a => !a.startsWith('--'));

  if (hosts.length === 0) {
    console.error('Usage: tsx scripts/run-comprehension.ts <hostname> | --all [--force]');
    process.exit(1);
  }

  console.log(`━━━ Running comprehension on ${hosts.length} dApp(s) ━━━`);
  console.log(`Force regenerate: ${force}\n`);

  const results: Awaited<ReturnType<typeof runOne>>[] = [];
  for (const h of hosts) {
    console.log(`\n[${h}]`);
    const r = await runOne(h, force);
    results.push(r);
  }

  console.log('\n━━━ Summary ━━━');
  console.log('dApp'.padEnd(30) + 'status'.padEnd(10) + 'archetype'.padEnd(15) + 'conf'.padStart(6) + 'flows'.padStart(8));
  console.log('─'.repeat(70));
  for (const r of results) {
    console.log(
      r.host.padEnd(30) +
      (r.ok ? 'ok' : 'FAIL').padEnd(10) +
      (r.archetype ?? '-').padEnd(15) +
      (r.confidence !== undefined ? r.confidence.toFixed(2) : '-').padStart(6) +
      String(r.flows ?? '-').padStart(8) +
      (r.error ? `  (${r.error.slice(0, 40)})` : '')
    );
  }

  // Summary artifact
  const summaryPath = join(process.cwd(), 'output', 'COMPREHENSION_SUMMARY.json');
  writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nWrote ${summaryPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });

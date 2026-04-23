#!/usr/bin/env npx tsx
/**
 * Run just the spec generator on existing valid-flows.json.
 * No browser, no LLM, $0.
 */
import 'dotenv/config';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const url = process.argv[2] || 'https://developer.avantisfi.com/trade';
const dappName = new URL(url).hostname.replace(/\./g, '-');
const outputDir = join(process.cwd(), 'output', dappName);

async function main() {
  const { createSpecGeneratorNode } = await import('../src/agent/nodes/spec-generator.js');
  const { emptyKnowledgeGraph } = await import('../src/agent/state.js');
  const { readFileSync } = await import('fs');

  // Load full KG for asset/component data
  let kg = emptyKnowledgeGraph();
  const kgPath = join(outputDir, 'knowledge-graph.json');
  if (existsSync(kgPath)) {
    kg = JSON.parse(readFileSync(kgPath, 'utf-8'));
    console.log(`Loaded KG: ${kg.components.length} components, ${kg.assets.length} assets`);
  }
  const config = { url, seedPhrase: '', apiKey: '', outputDir, headless: false,
    explorerModel: '', plannerModel: '', generatorModel: '', healerModel: '' };

  const node = createSpecGeneratorNode();
  const result = await node({
    messages: [], knowledgeGraph: kg, graph: { nodes: [], edges: [] },
    crawlData: null, testPlan: null, specFiles: [], testResults: [],
    iteration: 0, maxIterations: 3, config,
  } as any);

  console.log(`\nGenerated ${result.specFiles?.length || 0} spec files`);
  for (const f of result.specFiles || []) {
    console.log(`  ${f}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });

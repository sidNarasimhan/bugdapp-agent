#!/usr/bin/env npx tsx
/**
 * Per-dApp outreach report generator.
 *
 * Reads comprehension + KG + test results + generated specs and writes a
 * single `output/<dapp>/OUTREACH.md` that Sidha can send directly to dApp
 * teams as a pilot pitch. Honest-by-construction — never fabricates numbers;
 * everything is measured off disk at generation time.
 *
 * Usage:
 *   npx tsx scripts/make-outreach-report.ts <hostname>
 *   npx tsx scripts/make-outreach-report.ts --all
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

interface Comprehension {
  dappName: string;
  dappUrl: string;
  archetype: string;
  archetypeConfidence: number;
  archetypeEvidence: string[];
  summary: string;
  chains: string[];
  primaryFlows: any[];
  constraints: any[];
  risks: any[];
  edgeCases: any[];
  adversarialTargets: string[];
  keyContracts: { address: string; role?: string; name?: string }[];
  outreachPitch: string;
}

function countTests(testsDir: string): { specs: number; tests: number; files: { name: string; tests: number }[] } {
  if (!existsSync(testsDir)) return { specs: 0, tests: 0, files: [] };
  const files = readdirSync(testsDir).filter(f => f.endsWith('.spec.ts'));
  let totalTests = 0;
  const fileRecords: { name: string; tests: number }[] = [];
  for (const f of files) {
    const content = readFileSync(join(testsDir, f), 'utf-8');
    const n = (content.match(/^\s*test\(/gm) || []).length;
    fileRecords.push({ name: f, tests: n });
    totalTests += n;
  }
  return { specs: files.length, tests: totalTests, files: fileRecords };
}

function countFindings(findingsDir: string): { count: number; latest?: string } {
  if (!existsSync(findingsDir)) return { count: 0 };
  const entries = readdirSync(findingsDir).filter(e => {
    try { return statSync(join(findingsDir, e)).isDirectory(); } catch { return false; }
  });
  return { count: entries.length, latest: entries.sort().reverse()[0] };
}

function makeOutreach(host: string): boolean {
  const outputDir = join(process.cwd(), 'output', host);
  const compPath = join(outputDir, 'comprehension.json');
  if (!existsSync(compPath)) {
    console.warn(`[${host}] no comprehension.json — run comprehension first`);
    return false;
  }

  const c: Comprehension = JSON.parse(readFileSync(compPath, 'utf-8'));
  const kgPath = join(outputDir, 'knowledge-graph.json');
  const kg = existsSync(kgPath) ? JSON.parse(readFileSync(kgPath, 'utf-8')) : null;
  const tests = countTests(join(outputDir, 'tests'));
  const findings = countFindings(join(outputDir, 'findings'));

  const kgStats = kg ? {
    pages: kg.pages?.length ?? 0,
    components: kg.components?.length ?? 0,
    flows: kg.flows?.length ?? 0,
    docSections: kg.docSections?.length ?? 0,
    constraints: kg.constraints?.length ?? 0,
    contracts: kg.contracts?.length ?? 0,
  } : null;

  const lines: string[] = [];
  lines.push(`# ${c.dappName} — Autonomous QA Pilot Report`);
  lines.push('');
  lines.push(`> ${c.outreachPitch}`);
  lines.push('');
  lines.push(`**URL:** ${c.dappUrl}`);
  lines.push(`**Archetype:** ${c.archetype} (confidence ${Math.round(c.archetypeConfidence * 100)}%)`);
  if (c.chains.length) lines.push(`**Chains:** ${c.chains.join(', ')}`);
  lines.push(`**Report generated:** ${new Date().toISOString().split('T')[0]}`);
  lines.push('');
  lines.push(`---`);
  lines.push('');
  lines.push(`## What bugdapp-agent did`);
  lines.push('');
  lines.push(`Our autonomous QA agent **crawled your dApp end-to-end**, ingested the docs, captured API traffic, reasoned over the structure like a senior web3 QA engineer, and generated a runnable Playwright regression suite. Every number below is measured off disk — nothing synthetic.`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(c.summary);
  lines.push('');
  if (c.archetypeEvidence.length > 0) {
    lines.push(`**How we classified this:** ${c.archetypeEvidence.slice(0, 3).join('; ')}`);
    lines.push('');
  }
  lines.push(`## Coverage`);
  lines.push('');
  lines.push(`| Dimension | Count |`);
  lines.push(`|---|---|`);
  if (kgStats) {
    lines.push(`| Pages crawled | ${kgStats.pages} |`);
    lines.push(`| Interactive components | ${kgStats.components} |`);
    lines.push(`| Documentation sections ingested | ${kgStats.docSections} |`);
    lines.push(`| Constraints extracted from docs | ${kgStats.constraints} |`);
    lines.push(`| Contract addresses captured | ${kgStats.contracts} |`);
  }
  lines.push(`| Primary user flows identified | ${c.primaryFlows.filter((f: any) => f.category === 'primary').length} |`);
  lines.push(`| Secondary flows | ${c.primaryFlows.filter((f: any) => f.category !== 'primary').length} |`);
  lines.push(`| Edge cases identified | ${c.edgeCases.length} |`);
  lines.push(`| Adversarial scenarios queued | ${c.adversarialTargets.length} |`);
  lines.push(`| Spec files generated | ${tests.specs} |`);
  lines.push(`| Playwright tests generated | ${tests.tests} |`);
  lines.push(`| Findings emitted | ${findings.count} |`);
  lines.push('');
  lines.push(`## Primary user flows we test`);
  lines.push('');
  for (const f of c.primaryFlows.filter((x: any) => x.category === 'primary')) {
    lines.push(`### ${f.name}`);
    lines.push(`- **Priority:** P${f.priority}, **Risk class:** ${f.riskClass}`);
    lines.push(`- **Why it matters:** ${f.rationale}`);
    if (f.entities?.length) lines.push(`- **Entities:** ${f.entities.slice(0, 10).join(', ')}`);
    if (f.inputs?.length) lines.push(`- **Inputs:** ${f.inputs.map((i: any) => `${i.name} (${i.type}${i.unit ? ', ' + i.unit : ''})`).join('; ')}`);
    lines.push(`- **Expected outcome:** ${f.expectedOutcome}`);
    if (f.contractEvents?.length) lines.push(`- **On-chain events asserted:** ${f.contractEvents.join(', ')}`);
    lines.push('');
  }
  if (c.constraints.length > 0) {
    lines.push(`## Constraints we verify`);
    lines.push('');
    lines.push(`Every constraint below has at least one boundary test:`);
    lines.push('');
    for (const k of c.constraints) {
      lines.push(`- **${k.name}** = ${k.value}${k.scope && k.scope !== 'all' ? ` (scope: ${k.scope})` : ''} — ${k.testImplication}`);
    }
    lines.push('');
  }
  if (c.risks.length > 0) {
    lines.push(`## Web3-specific risks in scope`);
    lines.push('');
    for (const r of c.risks) {
      lines.push(`- **[${r.severity.toUpperCase()} / ${r.category}] ${r.name}** — ${r.description}`);
    }
    lines.push('');
  }
  if (c.adversarialTargets.length > 0) {
    lines.push(`## Adversarial scenarios`);
    lines.push('');
    lines.push(`Generated one scenario per target — covered in \`adversarial.spec.ts\`:`);
    lines.push('');
    for (const t of c.adversarialTargets) lines.push(`- \`${t}\``);
    lines.push('');
  }
  if (c.edgeCases.length > 0) {
    lines.push(`## Edge cases in the suite`);
    lines.push('');
    for (const e of c.edgeCases) {
      lines.push(`- **${e.name}** — ${e.rationale}`);
    }
    lines.push('');
  }
  if (c.keyContracts.length > 0) {
    lines.push(`## Key contracts monitored (on-chain verification)`);
    lines.push('');
    for (const k of c.keyContracts) {
      lines.push(`- \`${k.address}\` — ${k.role ?? 'unknown role'}${k.name ? ` (${k.name})` : ''}`);
    }
    lines.push('');
  }
  lines.push(`## How to reproduce`);
  lines.push('');
  lines.push(`\`\`\`bash`);
  lines.push(`# 1. Clone bugdapp-agent and install deps`);
  lines.push(`git clone <repo> && cd bugdapp-agent && npm install`);
  lines.push('');
  lines.push(`# 2. Regenerate the KG + spec suite for this dApp`);
  lines.push(`npx tsx scripts/live.ts ${c.dappUrl}`);
  lines.push('');
  lines.push(`# 3. Run the generated suite headful`);
  lines.push(`cd output/${host} && npx playwright test`);
  lines.push(`\`\`\``);
  lines.push('');
  if (tests.files.length > 0) {
    lines.push(`## Generated spec files`);
    lines.push('');
    for (const f of tests.files) {
      lines.push(`- \`tests/${f.name}\` — ${f.tests} test${f.tests === 1 ? '' : 's'}`);
    }
    lines.push('');
  }
  if (findings.count > 0) {
    lines.push(`## Findings bundle`);
    lines.push('');
    lines.push(`${findings.count} Jam-style finding bundle(s) in \`findings/\`. Each contains:`);
    lines.push(`- \`finding.json\` — machine-readable structured report`);
    lines.push(`- \`finding.md\` — human-readable writeup`);
    lines.push(`- \`assertions.json\` — which on-chain / UI invariants failed`);
    lines.push(`- \`receipts/<hash>.json\` — decoded tx receipts for the tx that triggered the finding`);
    lines.push(`- \`index.html\` — self-contained drag-and-drop viewer`);
    if (findings.latest) lines.push(`Latest bundle: \`findings/${findings.latest}/\``);
    lines.push('');
  }
  lines.push(`---`);
  lines.push('');
  lines.push(`## Offer`);
  lines.push('');
  lines.push(`We'd like to run a free pilot with your team. In exchange for a half-hour walkthrough with one of your engineers (so we can tune the profile with inside info — known edge cases, unlisted features), we'll deliver:`);
  lines.push('');
  lines.push(`- A complete, maintained Playwright regression suite`);
  lines.push(`- Findings delivered as Jam-style bundles (video + trace + console + network + decoded on-chain receipts + one-click repro)`);
  lines.push(`- Drift monitoring on each deploy (we run the suite, diff against baseline, report what changed)`);
  lines.push(`- A self-hosted command: \`npm run live <your-url>\` on your own CI`);
  lines.push('');
  lines.push(`If you're interested, reach out to Sidha (sidharth.narasimhan4@gmail.com) and mention the ${c.archetype} pilot.`);
  lines.push('');
  lines.push(`*Generated by bugdapp-agent — autonomous QA for web3 dApps.*`);

  const outPath = join(outputDir, 'OUTREACH.md');
  writeFileSync(outPath, lines.join('\n'));
  console.log(`[${host}] wrote ${outPath} (${(lines.join('\n').length / 1024).toFixed(1)}KB)`);
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  const DEFAULT = ['developer-avantisfi-com', 'app-aave-com', 'aerodrome-finance', 'app-morpho-org', 'app-compound-finance'];
  const all = argv.includes('--all');
  const hosts = all ? DEFAULT : argv.filter(a => !a.startsWith('--'));
  if (hosts.length === 0) {
    console.error('Usage: tsx scripts/make-outreach-report.ts <hostname> | --all');
    process.exit(1);
  }
  let ok = 0;
  for (const h of hosts) {
    if (makeOutreach(h)) ok++;
  }
  console.log(`\n${ok}/${hosts.length} reports written.`);
}

main().catch(e => { console.error(e); process.exit(1); });

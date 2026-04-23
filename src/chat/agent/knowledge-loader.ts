/**
 * Knowledge loader — pulls the pipeline's crawler + comprehension artifacts off
 * disk and compacts them into a system-prompt snippet for the executor agent.
 *
 * Reads from `output/<hostname>/`:
 *   - knowledge-graph.json    components, flows, constraints, pages
 *   - comprehension.json      archetype, primary flows, constraints, risks, adversarial targets
 *   - valid-flows.json        validated step sequences (if present)
 *   - tests/*.spec.ts         existing specs (title + rationale header)
 *
 * Everything is truncated / ranked so the prompt stays under a few KB.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface KnowledgePack {
  url: string;
  hostDir: string;
  summary: string;
  primaryFlowsBlock: string;
  constraintsBlock: string;
  risksBlock: string;
  adversarialBlock: string;
  componentsBlock: string;
  keyContractsBlock: string;
  existingSpecsBlock: string;
  docExtractsBlock: string;
  raw: { comprehension: any | null; kg: any | null };
}

function hostDir(url: string): string {
  try { return new URL(url).hostname.replace(/\./g, '-'); } catch { return url; }
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max) + '…';
}

export function loadKnowledge(url: string): KnowledgePack {
  const host = hostDir(url);
  const dir = join(process.cwd(), 'output', host);
  const comp = readJson(join(dir, 'comprehension.json'));
  const kg = readJson(join(dir, 'knowledge-graph.json'));

  const summary = comp?.summary
    ? `## dApp Summary (from LLM comprehension)\n${truncate(comp.summary, 600)}\n`
    : '';

  // ---------- Primary flows ----------
  let primaryFlowsBlock = '';
  if (comp?.primaryFlows?.length) {
    const lines = ['## Primary flows (comprehension-ranked)'];
    for (const f of comp.primaryFlows.slice(0, 6)) {
      lines.push(`- **${f.name}** (priority ${f.priority ?? '?'}, risk ${f.riskClass ?? '?'})`);
      if (f.rationale) lines.push(`    Rationale: ${truncate(f.rationale, 140)}`);
      if (f.expectedOutcome) lines.push(`    Expected: ${truncate(f.expectedOutcome, 140)}`);
      if (Array.isArray(f.inputs) && f.inputs.length) {
        lines.push(`    Inputs: ${f.inputs.map((i: any) => `${i.name}(${i.type}${i.unit ? ' ' + i.unit : ''})`).join(', ')}`);
      }
      if (Array.isArray(f.entities) && f.entities.length) {
        lines.push(`    Entities: ${f.entities.slice(0, 8).join(', ')}`);
      }
      if (Array.isArray(f.contractEvents) && f.contractEvents.length) {
        lines.push(`    Contract events: ${f.contractEvents.slice(0, 4).join(', ')}`);
      }
      if (f.requiresFundedWallet) lines.push(`    Requires funded wallet.`);
    }
    primaryFlowsBlock = lines.join('\n') + '\n';
  }

  // ---------- Constraints ----------
  let constraintsBlock = '';
  if (comp?.constraints?.length) {
    const lines = ['## Constraints (validation rules the dApp enforces)'];
    for (const c of comp.constraints.slice(0, 10)) {
      const s = typeof c === 'string' ? c : (c.rule || c.description || c.message || JSON.stringify(c));
      lines.push(`- ${truncate(s, 180)}`);
    }
    constraintsBlock = lines.join('\n') + '\n';
  }

  // ---------- Risks ----------
  let risksBlock = '';
  if (comp?.risks?.length) {
    const lines = ['## Known risks'];
    for (const r of comp.risks.slice(0, 6)) {
      const s = typeof r === 'string' ? r : (r.description || r.message || JSON.stringify(r));
      lines.push(`- ${truncate(s, 160)}`);
    }
    risksBlock = lines.join('\n') + '\n';
  }

  // ---------- Adversarial targets ----------
  let adversarialBlock = '';
  if (comp?.adversarialTargets?.length) {
    const lines = ['## Adversarial targets (things worth breaking)'];
    for (const a of comp.adversarialTargets.slice(0, 6)) {
      const s = typeof a === 'string' ? a : (a.target || a.description || JSON.stringify(a));
      lines.push(`- ${truncate(s, 160)}`);
    }
    adversarialBlock = lines.join('\n') + '\n';
  }

  // ---------- Components (top salient buttons/inputs per page) ----------
  let componentsBlock = '';
  if (kg?.components?.length) {
    const byPage = new Map<string, string[]>();
    for (const c of kg.components) {
      if (c.disabled || !c.name) continue;
      if (!['button', 'a', 'textbox', 'spinbutton', 'switch', 'checkbox', 'slider', 'tab'].includes(c.role)) continue;
      const page = c.pageId || 'shared';
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page)!.push(`${c.role}: "${truncate(c.name, 50)}"`);
    }
    const lines = ['## Components (top crawler-observed elements, per page)'];
    for (const [page, items] of byPage) {
      const head = items.slice(0, 12);
      lines.push(`**${page}** — ${head.join(', ')}${items.length > 12 ? `, +${items.length - 12} more` : ''}`);
    }
    componentsBlock = lines.join('\n') + '\n';
  }

  // ---------- Key contracts ----------
  let keyContractsBlock = '';
  if (comp?.keyContracts?.length) {
    const lines = ['## Key contracts'];
    for (const k of comp.keyContracts.slice(0, 6)) {
      const addr = k.address ? truncate(k.address, 42) : '';
      const name = k.name ? `**${k.name}**` : '';
      const desc = k.description ? ` — ${truncate(k.description, 100)}` : '';
      lines.push(`- ${name} \`${addr}\`${desc}`);
    }
    keyContractsBlock = lines.join('\n') + '\n';
  }

  // ---------- Existing specs ----------
  const testsDir = join(dir, 'tests');
  let existingSpecsBlock = '';
  if (existsSync(testsDir)) {
    const specs = readdirSync(testsDir).filter(f => f.endsWith('.spec.ts'));
    if (specs.length) {
      const lines = [`## Existing Playwright specs (${specs.length})`];
      const MAX_SPECS = 24;
      for (const f of specs.slice(0, MAX_SPECS)) {
        const fp = join(testsDir, f);
        const src = (() => { try { return readFileSync(fp, 'utf-8'); } catch { return ''; } })();
        const titleMatch = src.match(/test\(\s*["'`]([^"'`]+)["'`]/);
        const rationaleMatch = src.match(/\/\/\s*Rationale:\s*(.+)/);
        const title = titleMatch ? truncate(titleMatch[1], 90) : '(no title found)';
        const rationale = rationaleMatch ? ` — ${truncate(rationaleMatch[1].trim(), 90)}` : '';
        lines.push(`- \`${f}\`: ${title}${rationale}`);
      }
      if (specs.length > MAX_SPECS) lines.push(`- …and ${specs.length - MAX_SPECS} more`);
      existingSpecsBlock = lines.join('\n') + '\n';
    }
  }

  // ---------- Rule-like snippets from anywhere in the KG ----------
  // docSections hold the curated docs. But crawl-time UI state (error messages,
  // tooltips, disabled-button reasons) lives scattered across kg.actions,
  // kg.interactions, kg.edgeCases, etc. We sweep the whole KG for short strings
  // that look like rules/thresholds and surface them verbatim. This is how
  // "Minimum position size for this asset is 100.00 USDC" (a UI-observed
  // warning banner) makes it into the agent's prompt.
  let docExtractsBlock = '';
  if (kg) {
    const patterns = [
      /\b(minimum|maximum|min|max)\s+(position|leverage|amount|collateral|size|deposit|withdrawal|trade|order)/i,
      /\b\d+(?:\.\d+)?\s*(%|x|usd|usdc|eth|btc|sol|bps|basis\s*points|dollar)\b/i,
      /\b(fee|slippage|interest|apr|apy|limit|cap|threshold|bound|allowance)\b.{0,40}\d/i,
      /\b(market\s*hours|trading\s*hours|cutoff|deadline|expiry)\b/i,
      /\b(requires?|must|only|restricted|prohibited|not\s*allowed|cannot|unable\s+to)\b/i,
      /\b(insufficient|exceeds|too\s+(low|high|small|large))\b/i,
    ];
    const seen = new Set<string>();
    const hits: string[] = [];
    const visit = (s: string) => {
      if (!s || s.length < 10 || s.length > 260) return;
      // Strip leading type prefix like "p:", "h1:", "text:" that crawler adds
      const clean = s.replace(/^[a-z0-9]{1,6}:/i, '').replace(/\s+/g, ' ').trim();
      if (clean.length < 10) return;
      const normalized = clean.toLowerCase();
      if (seen.has(normalized)) return;
      if (!patterns.some(p => p.test(clean))) return;
      seen.add(normalized);
      hits.push(`- ${clean}`);
    };
    const walk = (node: any, depth = 0) => {
      if (hits.length >= 40 || depth > 8) return;
      if (typeof node === 'string') { visit(node); return; }
      if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
      if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) walk(node[k], depth + 1);
      }
    };
    // Walk sources most likely to hold rule-like strings
    walk(kg.docSections, 0);
    walk(kg.actions, 0);
    walk(kg.interactions, 0);
    walk(kg.edgeCases, 0);
    walk(kg.testCases, 0);
    walk(kg.constraints, 0);
    walk(kg.features, 0);

    if (hits.length) {
      docExtractsBlock = '## Rule-like snippets (scraped from crawl — min/max/leverage/fee/hours/errors)\n' + hits.join('\n') + '\n';
    }
  }

  return {
    url,
    hostDir: host,
    summary,
    primaryFlowsBlock,
    constraintsBlock,
    risksBlock,
    adversarialBlock,
    componentsBlock,
    keyContractsBlock,
    existingSpecsBlock,
    docExtractsBlock,
    raw: { comprehension: comp, kg },
  };
}

export function knowledgeBlock(pack: KnowledgePack): string {
  const parts = [
    pack.summary,
    pack.primaryFlowsBlock,
    pack.constraintsBlock,
    pack.docExtractsBlock,
    pack.risksBlock,
    pack.adversarialBlock,
    pack.componentsBlock,
    pack.keyContractsBlock,
    pack.existingSpecsBlock,
  ].filter(Boolean);
  if (parts.length === 0) return '';
  return '# CRAWLER + COMPREHENSION KNOWLEDGE\n\n' + parts.join('\n');
}

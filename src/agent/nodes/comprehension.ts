/**
 * Comprehension node — the "brain" that reasons over crawl + docs + KG to
 * produce a structured understanding of WHAT this dApp is and HOW it should
 * be tested.
 *
 * Input: KnowledgeGraph (post-crawler + KG-builder), optional explorer output.
 * Output: Comprehension.json — dApp archetype + primary flows (ranked) +
 * constraints + risks + edge cases + adversarial targets + key contracts +
 * outreach pitch.
 *
 * This is the single LLM step that converts "we have data about this dApp"
 * into "we understand this dApp well enough to test it like a web3 QA
 * engineer would". Downstream planner + spec-gen consume the comprehension
 * as the primary source of truth.
 *
 * Cost: ~$0.05–0.20 per dApp with deepseek-v3.2.
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, KnowledgeGraph, KGContract } from '../state.js';

export interface ComprehensionFlow {
  id: string;
  name: string;
  category: 'primary' | 'secondary' | 'utility';
  priority: 1 | 2 | 3;
  rationale: string;
  entities: string[];
  inputs: { name: string; type: string; unit?: string; notes?: string }[];
  expectedOutcome: string;
  riskClass: 'safe' | 'medium' | 'high';
  contractEvents?: string[];
  requiresFundedWallet: boolean;
}

export interface ComprehensionConstraint {
  name: string;
  value: string;
  scope?: string;
  source: 'docs' | 'api' | 'ui' | 'inferred';
  testImplication: string;
}

export interface ComprehensionRisk {
  name: string;
  description: string;
  category: 'financial' | 'security' | 'ux' | 'chain';
  severity: 'low' | 'medium' | 'high';
}

export interface ComprehensionEdgeCase {
  name: string;
  rationale: string;
  applicableToFlows: string[];
}

export interface Comprehension {
  dappName: string;
  dappUrl: string;
  archetype: 'swap' | 'perps' | 'lending' | 'staking' | 'yield' | 'cdp' | 'bridge' | 'nft' | 'launchpad' | 'prediction' | 'governance' | 'other' | 'unknown';
  archetypeConfidence: number;
  archetypeEvidence: string[];
  summary: string;
  chains: string[];
  primaryFlows: ComprehensionFlow[];
  constraints: ComprehensionConstraint[];
  risks: ComprehensionRisk[];
  edgeCases: ComprehensionEdgeCase[];
  adversarialTargets: string[];
  keyContracts: { address: string; role?: string; name?: string }[];
  outreachPitch: string;
  generatedAt: string;
  modelUsed: string;
}

const SYSTEM_PROMPT = `You are a senior web3 QA engineer. You think like someone who has manually tested DeFi dApps for years — you know what matters, what breaks, what users actually do, and what adversaries try.

Your job is to deeply understand a dApp from crawler + docs + API data, then produce a structured comprehension that downstream planners and spec generators consume as ground truth.

You must reason like a QA engineer:
- Identify the dApp's ARCHETYPE from concrete evidence (components, API patterns, docs vocabulary). The archetype determines how it should be tested.
- List PRIMARY user flows — the 3–7 things 80% of users actually do on this dApp. Rank them by criticality.
- List SECONDARY flows — less common but still important user journeys.
- Surface CONSTRAINTS from docs — minimums, maximums, fees, slippage, leverage caps, liquidation thresholds, market hours, role gating. Each constraint = at least one test.
- Surface RISKS specific to web3: approval drain, slippage attacks, liquidation cascades, oracle staleness, signature phishing, front-running, cross-chain bridge risks. Category-appropriate to the archetype.
- Surface EDGE CASES that break forms or flows — zero inputs, max inputs, rapid repeats, wrong network, unfunded wallet, insufficient allowance.
- List ADVERSARIAL TARGETS relevant to the archetype (e.g., "slippage-boundary" for swap, "liquidation-boundary" for lending, "approval-overspend" universal).
- Pick the TOP contracts that matter most for on-chain verification (router, pool, comet, factory — not every token address).
- Write a one-sentence OUTREACH PITCH: why auditing this dApp matters (what's at stake, who gets burned if it breaks).

CRITICAL RULES:
- Base everything on EVIDENCE from the data provided. If you can't cite evidence, don't claim it.
- If the archetype is ambiguous, say \`archetypeConfidence\` < 0.7 and list the ambiguity in evidence.
- Do NOT copy Avantis / GMX / perps assumptions onto every dApp. Infer the archetype from the data, then apply the right mental model.
- Prefer SPECIFIC over generic ("Supply USDC to the Base market at 75% LTV with ETH collateral") over vague ("Supply tokens").
- Output MUST be valid JSON matching the schema below. Nothing else.`;

function buildUserPrompt(kg: KnowledgeGraph, crawlData: any, config: { url: string }): string {
  const sections: string[] = [];

  const hostname = (() => { try { return new URL(config.url).hostname; } catch { return config.url; } })();
  sections.push(`## dApp
- URL: ${config.url}
- Hostname: ${hostname}
- Chain (detected): ${crawlData?.context?.chain ?? 'unknown'}
- Features (detected): ${(crawlData?.context?.features ?? []).join(', ') || 'none'}
- Title: ${crawlData?.context?.title ?? ''}
- Description: ${crawlData?.context?.description ?? ''}`);

  if (kg.pages.length > 0) {
    sections.push(`## Pages discovered (${kg.pages.length})
${kg.pages.slice(0, 15).map(p => `- ${p.name} (${p.url}) — ${p.elementCount} elements${p.walletRequired ? ', wallet-gated' : ''}`).join('\n')}`);
  }

  if (kg.components.length > 0) {
    const byRole: Record<string, string[]> = {};
    for (const c of kg.components) {
      if (c.disabled || !c.name) continue;
      if (!byRole[c.role]) byRole[c.role] = [];
      if (byRole[c.role].length < 25) byRole[c.role].push(c.name);
    }
    sections.push(`## Interactive components (by role)
${Object.entries(byRole).map(([role, names]) => `- ${role}: ${[...new Set(names)].slice(0, 25).join(', ')}`).join('\n')}`);
  }

  if (kg.assets.length > 0) {
    const byGroup: Record<string, string[]> = {};
    for (const a of kg.assets.slice(0, 100)) {
      if (!byGroup[a.group]) byGroup[a.group] = [];
      byGroup[a.group].push(a.symbol);
    }
    sections.push(`## Assets / entities (${kg.assets.length})
${Object.entries(byGroup).map(([g, syms]) => `- ${g}: ${syms.slice(0, 20).join(', ')}`).join('\n')}`);
  }

  if (kg.dropdownOptions.length > 0) {
    const byComp = new Map<string, string[]>();
    for (const d of kg.dropdownOptions.slice(0, 100)) {
      if (!byComp.has(d.componentId)) byComp.set(d.componentId, []);
      byComp.get(d.componentId)!.push(d.value);
    }
    sections.push(`## Dropdowns
${[...byComp.entries()].slice(0, 10).map(([id, vals]) => `- ${id}: ${[...new Set(vals)].slice(0, 15).join(', ')}`).join('\n')}`);
  }

  if (kg.constraints.length > 0) {
    sections.push(`## Extracted constraints (${kg.constraints.length})
${kg.constraints.slice(0, 30).map(c => `- [${c.scope ?? 'all'}] ${c.name} = ${c.value} → ${c.testImplication}`).join('\n')}`);
  }

  if (kg.docSections.length > 0) {
    sections.push(`## Documentation sections (${kg.docSections.length} total, top 20 by keyword density)
${kg.docSections.slice(0, 20).map(d =>
  `### ${d.title}\nKeywords: ${d.keywords.slice(0, 8).join(', ')}\n${d.content.slice(0, 800)}`
).join('\n\n')}`);
  }

  if (kg.apiEndpoints.length > 0) {
    sections.push(`## API endpoints observed (${kg.apiEndpoints.length})
${kg.apiEndpoints.slice(0, 20).map(a => `- ${a.path}: ${a.description}`).join('\n')}`);
  }

  if (kg.contracts && kg.contracts.length > 0) {
    const byRole: Record<string, KGContract[]> = {};
    for (const c of kg.contracts) {
      const r = c.role ?? 'other';
      if (!byRole[r]) byRole[r] = [];
      byRole[r].push(c);
    }
    // Prefer roles that matter for on-chain verification; drop long token lists.
    const rolesToShow = ['router', 'factory', 'pool', 'lending', 'perps', 'vault', 'oracle', 'staking', 'bridge', 'governance'];
    const contractLines: string[] = [];
    for (const r of rolesToShow) {
      if (byRole[r]) {
        for (const c of byRole[r].slice(0, 5)) {
          contractLines.push(`- [${r}] ${c.address}${c.chainId ? ` (chain ${c.chainId})` : ''}`);
        }
      }
    }
    if (byRole['token'] && byRole['token'].length > 0) {
      contractLines.push(`- [tokens] ${byRole['token'].length} token addresses (sample: ${byRole['token'].slice(0, 3).map(c => c.address).join(', ')})`);
    }
    if (byRole['other'] && byRole['other'].length > 0) {
      contractLines.push(`- [other] ${byRole['other'].length} addresses (unroled)`);
    }
    if (contractLines.length > 0) {
      sections.push(`## Contracts (on-chain, deduplicated from network traffic + docs)
${contractLines.join('\n')}`);
    }
  }

  sections.push(`## Output schema (return ONLY this JSON, nothing else)
\`\`\`json
{
  "dappName": "string",
  "dappUrl": "string",
  "archetype": "swap | perps | lending | staking | yield | cdp | bridge | nft | launchpad | prediction | governance | other | unknown",
  "archetypeConfidence": 0.0,
  "archetypeEvidence": ["short quote or observation", "..."],
  "summary": "1 paragraph: what this dApp does and for whom",
  "chains": ["base", "mainnet", ...],
  "primaryFlows": [
    {
      "id": "flow-1",
      "name": "Human-readable: e.g. 'Supply USDC to Base market'",
      "category": "primary | secondary | utility",
      "priority": 1,
      "rationale": "why users do this",
      "entities": ["USDC", "WETH", ...],
      "inputs": [{"name": "amount", "type": "number", "unit": "USDC"}],
      "expectedOutcome": "specific, verifiable UI + on-chain outcome",
      "riskClass": "safe | medium | high",
      "contractEvents": ["Supply", "Deposit"],
      "requiresFundedWallet": true
    }
  ],
  "constraints": [
    {"name": "...", "value": "...", "scope": "...", "source": "docs|api|ui|inferred", "testImplication": "..."}
  ],
  "risks": [
    {"name": "...", "description": "...", "category": "financial|security|ux|chain", "severity": "low|medium|high"}
  ],
  "edgeCases": [
    {"name": "...", "rationale": "...", "applicableToFlows": ["flow-1"]}
  ],
  "adversarialTargets": ["unlimited-approval", "slippage-boundary", "..."],
  "keyContracts": [
    {"address": "0x...", "role": "router", "name": "optional"}
  ],
  "outreachPitch": "1 sentence"
}
\`\`\`

Return ONLY the JSON. No prose. No markdown fences outside the JSON.`);

  return sections.join('\n\n');
}

/** Strip code fences + stray text, return a parsed Comprehension or throw. */
function parseComprehensionJson(content: string): any {
  // Strip ```json ... ``` fences if present.
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : content;
  // Find the outermost { ... } block.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) throw new Error('no JSON object found in LLM output');
  return JSON.parse(raw.slice(start, end + 1));
}

function coerceComprehension(raw: any, fallback: { url: string; hostname: string; modelUsed: string }): Comprehension {
  return {
    dappName: String(raw.dappName ?? fallback.hostname).slice(0, 120),
    dappUrl: String(raw.dappUrl ?? fallback.url),
    archetype: ['swap','perps','lending','staking','yield','cdp','bridge','nft','launchpad','prediction','governance','other','unknown'].includes(raw.archetype)
      ? raw.archetype
      : 'unknown',
    archetypeConfidence: Math.max(0, Math.min(1, Number(raw.archetypeConfidence) || 0)),
    archetypeEvidence: Array.isArray(raw.archetypeEvidence) ? raw.archetypeEvidence.map(String).slice(0, 10) : [],
    summary: String(raw.summary ?? '').slice(0, 2000),
    chains: Array.isArray(raw.chains) ? raw.chains.map(String).slice(0, 10) : [],
    primaryFlows: Array.isArray(raw.primaryFlows) ? raw.primaryFlows.slice(0, 30).map((f: any, i: number): ComprehensionFlow => ({
      id: String(f.id ?? `flow-${i + 1}`),
      name: String(f.name ?? 'unnamed').slice(0, 200),
      category: ['primary','secondary','utility'].includes(f.category) ? f.category : 'secondary',
      priority: [1,2,3].includes(Number(f.priority)) ? (Number(f.priority) as 1|2|3) : 2,
      rationale: String(f.rationale ?? '').slice(0, 500),
      entities: Array.isArray(f.entities) ? f.entities.map(String).slice(0, 20) : [],
      inputs: Array.isArray(f.inputs) ? f.inputs.slice(0, 10).map((i: any) => ({
        name: String(i.name ?? ''),
        type: String(i.type ?? 'string'),
        unit: i.unit ? String(i.unit) : undefined,
        notes: i.notes ? String(i.notes) : undefined,
      })) : [],
      expectedOutcome: String(f.expectedOutcome ?? '').slice(0, 500),
      riskClass: ['safe','medium','high'].includes(f.riskClass) ? f.riskClass : 'medium',
      contractEvents: Array.isArray(f.contractEvents) ? f.contractEvents.map(String).slice(0, 10) : undefined,
      requiresFundedWallet: Boolean(f.requiresFundedWallet),
    })) : [],
    constraints: Array.isArray(raw.constraints) ? raw.constraints.slice(0, 50).map((c: any) => ({
      name: String(c.name ?? ''),
      value: String(c.value ?? ''),
      scope: c.scope ? String(c.scope) : undefined,
      source: ['docs','api','ui','inferred'].includes(c.source) ? c.source : 'inferred',
      testImplication: String(c.testImplication ?? ''),
    })) : [],
    risks: Array.isArray(raw.risks) ? raw.risks.slice(0, 30).map((r: any) => ({
      name: String(r.name ?? ''),
      description: String(r.description ?? ''),
      category: ['financial','security','ux','chain'].includes(r.category) ? r.category : 'ux',
      severity: ['low','medium','high'].includes(r.severity) ? r.severity : 'medium',
    })) : [],
    edgeCases: Array.isArray(raw.edgeCases) ? raw.edgeCases.slice(0, 30).map((e: any) => ({
      name: String(e.name ?? ''),
      rationale: String(e.rationale ?? ''),
      applicableToFlows: Array.isArray(e.applicableToFlows) ? e.applicableToFlows.map(String) : [],
    })) : [],
    adversarialTargets: Array.isArray(raw.adversarialTargets) ? raw.adversarialTargets.map(String).slice(0, 20) : [],
    keyContracts: Array.isArray(raw.keyContracts) ? raw.keyContracts.slice(0, 15).map((c: any) => ({
      address: String(c.address ?? '').toLowerCase(),
      role: c.role ? String(c.role) : undefined,
      name: c.name ? String(c.name) : undefined,
    })).filter((c: any) => /^0x[a-f0-9]{40}$/.test(c.address)) : [],
    outreachPitch: String(raw.outreachPitch ?? '').slice(0, 400),
    generatedAt: new Date().toISOString(),
    modelUsed: fallback.modelUsed,
  };
}

export function createComprehensionNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType> & { comprehension?: Comprehension }> => {
    const { config, knowledgeGraph: kg, crawlData } = state;
    const model = config.plannerModel || 'deepseek/deepseek-chat-v3-0324';

    console.log('━━━ Comprehension: Reasoning over dApp data ━━━');

    // Short-circuit: if a recent comprehension already exists on disk and the
    // KG hasn't grown, reuse it. Saves credits on re-runs.
    const outputPath = join(config.outputDir, 'comprehension.json');
    if (existsSync(outputPath)) {
      try {
        const cached = JSON.parse(readFileSync(outputPath, 'utf-8')) as Comprehension;
        console.log(`[Comprehension] cached (${cached.archetype}, ${cached.primaryFlows.length} flows) — reusing`);
        return { comprehension: cached } as any;
      } catch { /* fall through to regenerate */ }
    }

    const llm = new ChatOpenAI({
      model,
      configuration: { baseURL: 'https://openrouter.ai/api/v1' },
      apiKey: config.apiKey,
      temperature: 0,
      maxTokens: 6000,
    });

    const prompt = buildUserPrompt(kg, crawlData, { url: config.url });
    const hostname = (() => { try { return new URL(config.url).hostname; } catch { return config.url; } })();

    const started = Date.now();
    const result = await llm.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ]);
    const durationMs = Date.now() - started;

    const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    let raw: any;
    try {
      raw = parseComprehensionJson(content);
    } catch (e) {
      console.error(`[Comprehension] LLM returned invalid JSON: ${(e as Error).message}`);
      console.error(`[Comprehension] First 500 chars of response: ${content.slice(0, 500)}`);
      throw new Error(`Comprehension failed: ${(e as Error).message}`);
    }

    const comprehension = coerceComprehension(raw, { url: config.url, hostname, modelUsed: model });
    writeFileSync(outputPath, JSON.stringify(comprehension, null, 2));

    console.log(`[Comprehension] archetype: ${comprehension.archetype} (conf ${comprehension.archetypeConfidence.toFixed(2)})`);
    console.log(`[Comprehension] flows: ${comprehension.primaryFlows.length} (${comprehension.primaryFlows.filter(f => f.category === 'primary').length} primary)`);
    console.log(`[Comprehension] constraints: ${comprehension.constraints.length}, risks: ${comprehension.risks.length}, edgeCases: ${comprehension.edgeCases.length}`);
    console.log(`[Comprehension] keyContracts: ${comprehension.keyContracts.length}`);
    console.log(`[Comprehension] took ${(durationMs/1000).toFixed(1)}s, wrote ${outputPath}`);

    return { comprehension } as any;
  };
}

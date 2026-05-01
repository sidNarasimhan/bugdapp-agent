/**
 * Doc Structurer — parse each docSection into {topics, rules,
 * referencedModuleIds}. Transforms raw docs blobs into navigable structured
 * data that Module Discovery + Capability Naming can cite.
 *
 * One LLM call per doc section (Sonnet 4.5) but input is tiny so
 * ~$0.005 each. 16 docs × $0.005 ≈ $0.08 for Avantis.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../core/llm.js';
import type { AgentStateType, StructuredDoc } from '../agent/state.js';

// Default DeepSeek — per-doc {topics, rules} extraction is exactly the kind
// of small structured-output task DeepSeek is good at. ~10x cheaper.
const DOC_MODEL = process.env.DOC_MODEL ?? 'deepseek/deepseek-chat';

export function createDocStructurerNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { knowledgeGraph: kg, config } = state;
    const rawDocs = kg.docSections ?? [];
    if (rawDocs.length === 0) {
      console.log('[DocStructurer] no docSections, skipping');
      return { structuredDocs: [] };
    }

    console.log(`━━━ Doc Structurer: parsing ${rawDocs.length} doc sections ━━━`);
    const client = createOpenRouterClient(config.apiKey || process.env.OPENROUTER_API_KEY);

    const structured: StructuredDoc[] = [];
    let totalTokens = 0;
    for (let i = 0; i < rawDocs.length; i++) {
      const d: any = rawDocs[i];
      const id = d.id ?? `doc:${i}`;
      const title = d.title ?? '(untitled)';
      const content = String(d.content ?? d.text ?? '').slice(0, 3000);
      if (content.length < 40) {
        structured.push({ id, title, content, topics: [], rules: [], referencesModuleIds: [] });
        continue;
      }

      try {
        const resp = await client.messages.create({
          model: DOC_MODEL,
          max_tokens: 800,
          temperature: 0,
          system: [
            'You parse one doc section of a Web3 dApp into structured data.',
            'Extract:',
            '- topics: 2-5 short labels (e.g. "zero-fee perpetuals", "leverage", "collateral")',
            '- rules: short rule-like statements extracted VERBATIM or close to it (e.g. "Min leverage for ZFP is 75x", "Market orders only for ZFP", "Min position size 100 USDC"). Must be specific + testable.',
            '',
            'Return STRICT JSON: {"topics": string[], "rules": string[]}. No prose.',
          ].join('\n'),
          messages: [{ role: 'user', content: JSON.stringify({ title, content }) }],
        });
        totalTokens += (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0);
        const text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
        const json = extractJson(text);
        structured.push({
          id, title, content,
          topics: Array.isArray(json?.topics) ? json.topics.slice(0, 8).map((x: any) => String(x).slice(0, 60)) : [],
          rules: Array.isArray(json?.rules) ? json.rules.slice(0, 10).map((x: any) => String(x).slice(0, 200)) : [],
          referencesModuleIds: [],
        });
      } catch (e: any) {
        console.warn(`  ✗ ${title}: ${e?.message ?? e}`);
        structured.push({ id, title, content, topics: [], rules: [], referencesModuleIds: [] });
      }
    }

    const totalRules = structured.reduce((n, d) => n + d.rules.length, 0);
    const totalTopics = structured.reduce((n, d) => n + d.topics.length, 0);
    console.log(`[DocStructurer] ${structured.length} docs processed, ${totalTopics} topics, ${totalRules} rules · ~${Math.round(totalTokens / 1000)}k tok`);

    writeFileSync(join(config.outputDir, 'structured-docs.json'), JSON.stringify(structured, null, 2));
    return { structuredDocs: structured };
  };
}

function extractJson(s: string): any | null {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (fenced ? fenced[1] : s).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

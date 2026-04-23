/**
 * Spec matcher. Classifies a user task against Avantis's available Playwright
 * specs to decide: run an existing spec (cheap) or drive the browser via the
 * executor agent (expensive, needed for novel tasks).
 *
 * Uses DeepSeek via OpenRouter — cheap + deterministic enough for this.
 */
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../../llm/openrouter.js';
import { avantisProfile } from '../../agent/profiles/avantis.js';

const MATCH_MODEL = process.env.MATCH_MODEL ?? 'deepseek/deepseek-chat';

export type MatchMode = 'spec' | 'act' | 'blocked';

export interface MatchResult {
  mode: MatchMode;
  specFile?: string;        // when mode='spec'
  reason: string;
  availableSpecs: string[];
  confidence?: number;
}

function hostDir(url: string): string {
  try { return new URL(url).hostname.replace(/\./g, '-'); } catch { return url; }
}

export function listAvantisSpecs(): string[] {
  const testsDir = join(process.cwd(), 'output', hostDir(avantisProfile.url), 'tests');
  if (!existsSync(testsDir)) return [];
  return readdirSync(testsDir).filter(f => f.endsWith('.spec.ts'));
}

function specIsRunnable(): boolean {
  const outputDir = join(process.cwd(), 'output', hostDir(avantisProfile.url));
  return existsSync(join(outputDir, 'tests'));
}

export async function matchTaskToSpec(task: string): Promise<MatchResult> {
  const specs = listAvantisSpecs();
  if (!specIsRunnable() || specs.length === 0) {
    return {
      mode: 'act',
      reason: 'No Avantis specs on disk — falling back to act-observe mode',
      availableSpecs: specs,
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      mode: 'act',
      reason: 'No OPENROUTER_API_KEY — defaulting to act mode (cannot classify)',
      availableSpecs: specs,
    };
  }

  try {
    const client = createOpenRouterClient(apiKey);
    const resp = await client.messages.create({
      model: MATCH_MODEL,
      max_tokens: 300,
      temperature: 0,
      system:
        'You match a user QA task to exactly one existing Playwright spec file, or return "none" if no spec fits. ' +
        'Respond in strict JSON: {"spec": "<filename or null>", "confidence": 0.0-1.0, "reason": "<one sentence>"}. ' +
        'Only suggest a spec if it clearly covers the task. Prefer the most specific spec. ' +
        'If the user is asking for something novel (e.g. close a position, check portfolio, verify a specific error) ' +
        'and no spec matches, return spec: null.',
      messages: [{
        role: 'user',
        content: JSON.stringify({ task, available_specs: specs, dApp: 'Avantis', archetype: 'perps' }),
      }],
    });
    const text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
    const json = extractJson(text);
    if (!json || typeof json.spec === 'undefined') {
      return { mode: 'act', reason: 'Matcher returned malformed JSON — falling back to act', availableSpecs: specs };
    }
    if (json.spec && typeof json.spec === 'string' && specs.includes(json.spec)) {
      return {
        mode: 'spec',
        specFile: json.spec,
        reason: String(json.reason ?? 'matched'),
        availableSpecs: specs,
        confidence: typeof json.confidence === 'number' ? json.confidence : undefined,
      };
    }
    return {
      mode: 'act',
      reason: String(json.reason ?? 'no matching spec, using act mode'),
      availableSpecs: specs,
      confidence: typeof json.confidence === 'number' ? json.confidence : undefined,
    };
  } catch (e: any) {
    return {
      mode: 'act',
      reason: `Matcher LLM call failed (${e?.message ?? e}) — defaulting to act`,
      availableSpecs: specs,
    };
  }
}

function extractJson(s: string): any | null {
  // handle fenced blocks
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

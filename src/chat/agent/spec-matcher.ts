/**
 * Spec matcher. Classifies a user task against the dApp's available Playwright
 * specs to decide: run an existing spec (cheap, deterministic) or drive the
 * browser via the executor agent (expensive, needed for novel tasks).
 *
 * For each spec on disk we extract:
 *   - `test('<title>', ...)` titles
 *   - any `// Rationale: ...` comment immediately above each test
 *   - any `// Expected: ...` comment
 * and pass these to DeepSeek so matching is based on intent, not filenames.
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../../llm/openrouter.js';
import { avantisProfile } from '../../agent/profiles/avantis.js';
import type { DAppProfile } from '../../agent/profiles/types.js';

const MATCH_MODEL = process.env.MATCH_MODEL ?? 'deepseek/deepseek-chat';

export type MatchMode = 'spec' | 'act' | 'blocked';

export interface MatchResult {
  mode: MatchMode;
  specFile?: string;
  testTitle?: string;
  reason: string;
  availableSpecs: string[];
  confidence?: number;
}

export interface SpecDescriptor {
  file: string;
  tests: Array<{ title: string; rationale?: string; expected?: string }>;
}

function hostDir(url: string): string {
  try { return new URL(url).hostname.replace(/\./g, '-'); } catch { return url; }
}

export function listSpecs(profile: DAppProfile = avantisProfile): string[] {
  const testsDir = join(process.cwd(), 'output', hostDir(profile.url), 'tests');
  if (!existsSync(testsDir)) return [];
  return readdirSync(testsDir).filter(f => f.endsWith('.spec.ts'));
}

/** Back-compat alias used by nl-agent.ts. */
export const listAvantisSpecs = () => listSpecs(avantisProfile);

export function describeSpecs(profile: DAppProfile = avantisProfile): SpecDescriptor[] {
  const testsDir = join(process.cwd(), 'output', hostDir(profile.url), 'tests');
  if (!existsSync(testsDir)) return [];
  const files = readdirSync(testsDir).filter(f => f.endsWith('.spec.ts'));
  const out: SpecDescriptor[] = [];
  for (const file of files) {
    const src = (() => { try { return readFileSync(join(testsDir, file), 'utf-8'); } catch { return ''; } })();
    const tests: SpecDescriptor['tests'] = [];
    // Walk top-to-bottom, associating adjacent // Rationale / // Expected lines with the next test(...)
    const lines = src.split('\n');
    let pendingRationale: string | undefined;
    let pendingExpected: string | undefined;
    for (const raw of lines) {
      const line = raw.trim();
      const rat = line.match(/^\/\/\s*Rationale:\s*(.+)$/i);
      if (rat) { pendingRationale = rat[1].trim(); continue; }
      const exp = line.match(/^\/\/\s*Expected:\s*(.+)$/i);
      if (exp) { pendingExpected = exp[1].trim(); continue; }
      const t = line.match(/^test\(\s*["'`]([^"'`]+)["'`]/);
      if (t) {
        tests.push({ title: t[1], rationale: pendingRationale, expected: pendingExpected });
        pendingRationale = undefined;
        pendingExpected = undefined;
      }
    }
    out.push({ file, tests });
  }
  return out;
}

function specIsRunnable(profile: DAppProfile): boolean {
  return existsSync(join(process.cwd(), 'output', hostDir(profile.url), 'tests'));
}

export async function matchTaskToSpec(task: string, profile: DAppProfile = avantisProfile): Promise<MatchResult> {
  const specs = listSpecs(profile);
  if (!specIsRunnable(profile) || specs.length === 0) {
    return {
      mode: 'act',
      reason: `No ${profile.name} specs on disk — falling back to act-observe mode`,
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

  const descriptors = describeSpecs(profile);
  const menu = descriptors.map(d => ({
    file: d.file,
    tests: d.tests.slice(0, 3).map(t => ({
      title: t.title,
      ...(t.rationale ? { rationale: t.rationale.slice(0, 160) } : {}),
      ...(t.expected ? { expected: t.expected.slice(0, 160) } : {}),
    })),
  }));

  try {
    const client = createOpenRouterClient(apiKey);
    const resp = await client.messages.create({
      model: MATCH_MODEL,
      max_tokens: 400,
      temperature: 0,
      system:
        'You match a user QA task to exactly one existing Playwright spec (and a specific test inside it), or return null if nothing fits. ' +
        'Each spec entry includes file, test titles, and the rationale/expected comments for context. ' +
        'Respond in STRICT JSON: {"spec": "<filename or null>", "test": "<matched test title or null>", "confidence": 0.0-1.0, "reason": "<one sentence>"}. ' +
        'Only suggest a spec if it clearly covers the user\'s task. Prefer the most specific match. ' +
        'If the user is doing something not in the menu (e.g. close a position, check portfolio, reproduce an error), return spec:null.',
      messages: [{
        role: 'user',
        content: JSON.stringify({ task, dApp: profile.name, archetype: profile.archetype, menu }),
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
        testTitle: typeof json.test === 'string' ? json.test : undefined,
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
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

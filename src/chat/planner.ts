/**
 * Plan generator. Given a parsed command + dApp profile + the list of specs
 * that actually exist on disk, ask the LLM for a concrete plan the user can
 * approve. The LLM is NOT allowed to invent specs — we list what's there.
 *
 * Cheap model: deepseek/deepseek-chat or similar via OpenRouter. Temperature 0.
 */
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../llm/openrouter.js';
import type { DAppProfile } from '../agent/profiles/types.js';
import type { SpecFilter } from './commands.js';

const PLAN_MODEL = process.env.PLAN_MODEL ?? 'deepseek/deepseek-chat';

function hostDir(url: string): string {
  try { return new URL(url).hostname.replace(/\./g, '-'); } catch { return url; }
}

export interface PlanContext {
  dApp: DAppProfile;
  filter: SpecFilter;
  availableSpecs: string[];
  matchedSpecs: string[];
  hasCachedCrawl: boolean;
}

export function buildPlanContext(dApp: DAppProfile, filter: SpecFilter): PlanContext {
  const outputDir = join(process.cwd(), 'output', hostDir(dApp.url));
  const testsDir = join(outputDir, 'tests');
  const availableSpecs = existsSync(testsDir)
    ? readdirSync(testsDir).filter(f => f.endsWith('.spec.ts'))
    : [];
  const hasCachedCrawl = existsSync(join(outputDir, 'context.json'));

  const matchedSpecs = filterSpecs(availableSpecs, filter);
  return { dApp, filter, availableSpecs, matchedSpecs, hasCachedCrawl };
}

function filterSpecs(specs: string[], filter: SpecFilter): string[] {
  if (filter === 'all') return specs;
  const patterns: Record<string, RegExp> = {
    perps: /(perps|long|short|trade)/i,
    swap: /swap/i,
    lending: /(lending|supply|borrow)/i,
    staking: /(stake|staking)/i,
    cdp: /(cdp|vault)/i,
    yield: /(yield|farm)/i,
    navigation: /navigation/i,
    adversarial: /adversarial/i,
  };
  const p = patterns[filter];
  return p ? specs.filter(s => p.test(s)) : [];
}

export async function generatePlan(ctx: PlanContext): Promise<string> {
  if (!ctx.hasCachedCrawl) {
    return [
      `⚠️  **Cannot run** — no cached crawl for ${ctx.dApp.name} (${ctx.dApp.url}).`,
      `A fresh run would need OpenRouter credits to crawl + comprehend the dApp first.`,
      `Run locally: \`npm run live ${ctx.dApp.url}\` once, then I can test from cache.`,
      `Available (cached) dApps: see \`list\`.`,
    ].join('\n');
  }

  if (ctx.matchedSpecs.length === 0) {
    return [
      `⚠️  No \`${ctx.filter}\` specs found for **${ctx.dApp.name}**.`,
      `Available specs on disk: ${ctx.availableSpecs.map(s => '`' + s + '`').join(', ') || '(none)'}.`,
      `Try a different flow, or \`audit ${ctx.dApp.name.toLowerCase()}\` for the full suite.`,
    ].join('\n');
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Deterministic fallback — no LLM needed if key missing
    return deterministicPlan(ctx);
  }

  try {
    const client = createOpenRouterClient(apiKey);
    const resp = await client.messages.create({
      model: PLAN_MODEL,
      max_tokens: 400,
      temperature: 0,
      system:
        'You are the planning brain of bugdapp-agent, a Web3 QA agent. ' +
        'You write short, concrete plans for a human operator to approve before execution. ' +
        'NEVER invent test files. Only reference specs from the provided list. ' +
        'Plan format: 1) what will be run, 2) how long approx, 3) what will be reported. ' +
        'Be terse. No marketing. No emoji spam. 4–8 lines max.',
      messages: [{
        role: 'user',
        content: JSON.stringify({
          dApp: ctx.dApp.name,
          url: ctx.dApp.url,
          archetype: ctx.dApp.archetype,
          chain: ctx.dApp.network.chain,
          filter: ctx.filter,
          specs_that_will_run: ctx.matchedSpecs,
          values: ctx.dApp.values,
          note: 'Wallet is a test seed phrase. All actions use MetaMask test wallet on live chain state. Reports go to Notion.',
        }),
      }],
    });
    const text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
    if (!text) return deterministicPlan(ctx);
    return text;
  } catch (e: any) {
    console.warn(`[planner] LLM failed, falling back: ${e?.message ?? e}`);
    return deterministicPlan(ctx);
  }
}

function deterministicPlan(ctx: PlanContext): string {
  const specList = ctx.matchedSpecs.map(s => `  • \`${s}\``).join('\n');
  const etaMin = Math.max(1, Math.round(ctx.matchedSpecs.length * 1.5));
  return [
    `**Plan for ${ctx.dApp.name}** (${ctx.filter}, ${ctx.dApp.archetype} on ${ctx.dApp.network.chain})`,
    `Specs to run (${ctx.matchedSpecs.length}):`,
    specList,
    `Estimated runtime: ~${etaMin} min.`,
    `On failure: Notion ticket per failed spec, link posted back here.`,
  ].join('\n');
}

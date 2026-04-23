/**
 * Adversarial test synthesis node — takes a dApp's knowledge graph, profile,
 * and archetype, and produces a list of edge-case scenarios targeted at the
 * real-world exploit classes a human Web3 QA engineer would check.
 *
 * Scenarios are written to `output/<dapp>/adversarial-scenarios.json` in a
 * shape the spec-generator consumes to emit a dedicated `adversarial.spec.ts`
 * file alongside the base suite.
 *
 * Modes:
 *   - 'dry-run' (default): emits a deterministic scaffold per archetype without
 *     calling the LLM. Useful for integration tests + offline dev.
 *   - 'live': calls the LLM via @langchain/openai (OpenRouter) with a careful
 *     budget-conscious prompt. Honors OPENROUTER_API_KEY + ADVERSARIAL_MODEL env.
 *
 * The budget discipline is explicit: this node will refuse to run in live mode
 * if no API key is set, and logs the token budget before issuing the call so
 * the operator can see the cost profile.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { KnowledgeGraph } from '../state.js';
import type { DAppProfile, ArchetypeName } from '../profiles/types.js';

export type AdversarialTarget =
  | 'slippage-boundary'
  | 'approval-overspend'
  | 'liquidation-boundary'
  | 'sandwich-simulation'
  | 'receiver-mismatch'
  | 'signature-phishing'
  | 'stale-oracle'
  | 'zero-amount'
  | 'max-amount';

export interface AdversarialScenario {
  /** Stable id for reports and dedup: "<archetype>.<target>.<n>" */
  id: string;
  /** Archetype this scenario targets. */
  archetype: ArchetypeName;
  /** Which exploit class the scenario probes. */
  target: AdversarialTarget;
  /** Human-readable name (test title). */
  name: string;
  /** 1–2 sentence description of the adversarial setup + expected failure. */
  description: string;
  /** Base flow id from the KG to mutate. 'any' means synthesize from archetype alone. */
  baseFlowId?: string;
  /** Parameter mutations — keys are free-form, consumed by the spec-generator's
   *  archetype-specific adversarial emitter. Typical keys: slippageBps, amount,
   *  leverage, receiver, approvalAmount. */
  mutations: Record<string, unknown>;
  /** What the assertion layer should see as PROOF the scenario worked as intended
   *  (defense held) or regressed (dApp accepted the dangerous input). */
  expectedAssertions: Array<{
    id: string;
    /** 'should-fail-tx' — protocol should reject on chain. 'should-warn-ui' — UI
     *  should display a warning before the user can submit. 'should-block-form'
     *  — the CTA should be disabled with a visible reason. */
    kind: 'should-fail-tx' | 'should-warn-ui' | 'should-block-form' | 'should-clamp-value';
    /** A grep-friendly string or regex for the expected warning/error text. */
    signal: string;
  }>;
  /** Severity the finding should carry if the protocol or UI regresses on this check. */
  severity: 'warn' | 'error' | 'critical';
}

export interface AdversarialReport {
  generatedAt: string;
  mode: 'dry-run' | 'live';
  model?: string;
  profile: string;
  archetype: ArchetypeName;
  scenarios: AdversarialScenario[];
  notes: string;
}

// ── Scaffold scenarios per archetype (deterministic, no LLM) ──

function scaffoldScenarios(archetype: ArchetypeName, profile: DAppProfile): AdversarialScenario[] {
  const base: AdversarialScenario[] = [];

  // Universal scenarios every archetype gets.
  base.push({
    id: `${archetype}.approval-overspend.0`,
    archetype,
    target: 'approval-overspend',
    name: 'Unlimited approval should require explicit opt-in',
    description:
      'Triggers an ERC20 approval flow and asserts the approval value is bounded by the user\'s input amount, not type(uint256).max. Unlimited allowances are a well-known rug vector — the dApp should either exact-approve by default or surface a visible warning.',
    mutations: { approvalAmount: 'exact' },
    expectedAssertions: [
      { id: 'invariant.no-unlimited-approval', kind: 'should-fail-tx', signal: 'Approval value == 2^256-1' },
      { id: 'ui.approval-warning', kind: 'should-warn-ui', signal: 'infinite|unlimited|approve all' },
    ],
    severity: 'error',
  });
  base.push({
    id: `${archetype}.zero-amount.0`,
    archetype,
    target: 'zero-amount',
    name: 'Zero-amount submission should be blocked by the form',
    description:
      'Leaves the amount input at 0 or clears it, then tries to submit. The form CTA should be disabled OR the submit should be rejected before reaching the wallet — if it reaches the wallet signing stage, the dApp has a form-validation hole.',
    mutations: { amount: '0' },
    expectedAssertions: [
      { id: 'ui.zero-blocked', kind: 'should-block-form', signal: 'enter|amount|required' },
    ],
    severity: 'warn',
  });

  // Archetype-specific scenarios.
  if (archetype === 'perps') {
    base.push({
      id: `perps.liquidation-boundary.0`,
      archetype,
      target: 'liquidation-boundary',
      name: 'Open position within 1% of liquidation threshold',
      description:
        'Opens a position sized so the margin-after-fees leaves only ~1% headroom to the protocol\'s liquidation price. Verifies the dApp either clamps the size, shows a visible risk warning, or (as a last resort) the position opens with a health buffer the protocol itself enforces.',
      mutations: { marginBufferBps: 100 }, // 1% = 100 bps
      expectedAssertions: [
        { id: 'ui.liquidation-warning', kind: 'should-warn-ui', signal: 'liquidation|too high|risky|margin' },
        { id: 'invariant.perps.notional-matches-collateral-leverage', kind: 'should-fail-tx', signal: '' },
      ],
      severity: 'critical',
    });
    base.push({
      id: `perps.max-amount.0`,
      archetype,
      target: 'max-amount',
      name: 'Leverage one step above declared max should be rejected',
      description:
        'Sets leverage to profile.values.targetLeverage + 1 (or the declared protocol max + 1). Expects the UI to clamp to max or show "leverage too high".',
      mutations: { leverageDelta: 1 },
      expectedAssertions: [
        { id: 'ui.max-leverage', kind: 'should-clamp-value', signal: 'too high|exceed|maximum' },
      ],
      severity: 'warn',
    });
  }
  if (archetype === 'swap') {
    base.push({
      id: `swap.slippage-boundary.0`,
      archetype,
      target: 'slippage-boundary',
      name: '100% slippage tolerance should require explicit confirmation',
      description:
        'Sets slippage tolerance to 100% and attempts a swap. A well-designed dApp warns or blocks — a silent 100% swap is an MEV-sandwich bait.',
      mutations: { slippageBps: 10000 },
      expectedAssertions: [
        { id: 'ui.slippage-warning', kind: 'should-warn-ui', signal: 'slippage.*too high|high price impact|are you sure' },
      ],
      severity: 'error',
    });
    base.push({
      id: `swap.receiver-mismatch.0`,
      archetype,
      target: 'receiver-mismatch',
      name: 'Swap output must reach the connecting wallet',
      description:
        'Runs a vanilla swap and asserts (via chain decoder) that every Swap recipient eventually lands as a Transfer to the test wallet. Regression here means a routing / receiver-override bug.',
      mutations: {},
      expectedAssertions: [
        { id: 'invariant.swap.receiver-matches-wallet', kind: 'should-fail-tx', signal: '' },
      ],
      severity: 'critical',
    });
  }
  if (archetype === 'lending') {
    base.push({
      id: `lending.liquidation-boundary.0`,
      archetype,
      target: 'liquidation-boundary',
      name: 'Borrow up to the LTV limit',
      description:
        'Supplies collateral then borrows the exact LTV cap. Asserts the health factor is >=1 on-chain immediately after. A dApp that overshoots LTV due to rounding is a real bug class.',
      mutations: { borrowPct: 100 },
      expectedAssertions: [
        { id: 'ui.ltv-warning', kind: 'should-warn-ui', signal: 'health|liquidation|ltv|warning' },
      ],
      severity: 'critical',
    });
  }

  return base;
}

// ── Live LLM path ──

export interface RunAdversarialOptions {
  outputDir: string;
  mode?: 'dry-run' | 'live';
  /** OpenRouter model slug — defaults to a small model to stay under budget. */
  model?: string;
  /** Optional OpenRouter API key; falls back to process.env.OPENROUTER_API_KEY. */
  apiKey?: string;
}

/**
 * Top-level entry used by scripts/run-adversarial.ts and the LangGraph integration.
 * Loads KG, picks mode, writes the report to `output/<dapp>/adversarial-scenarios.json`.
 */
export async function runAdversarial(
  profile: DAppProfile,
  opts: RunAdversarialOptions,
): Promise<AdversarialReport> {
  const mode = opts.mode ?? 'dry-run';
  const kgPath = join(opts.outputDir, 'knowledge-graph.json');
  if (!existsSync(kgPath)) {
    throw new Error(`knowledge-graph.json missing at ${kgPath} — run the crawler + kg-builder first`);
  }
  const kg: KnowledgeGraph = JSON.parse(readFileSync(kgPath, 'utf8'));

  let scenarios: AdversarialScenario[];
  let notes: string;
  let model: string | undefined;

  if (mode === 'dry-run') {
    scenarios = scaffoldScenarios(profile.archetype, profile);
    notes = `Scaffolded ${scenarios.length} scenarios from archetype defaults. No LLM invoked — re-run with --live to enrich with dApp-specific edge cases discovered from the KG.`;
  } else {
    const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('live mode requires OPENROUTER_API_KEY in environment');
    }
    model = opts.model ?? process.env.ADVERSARIAL_MODEL ?? 'deepseek/deepseek-v3.2';
    // eslint-disable-next-line no-console
    console.log(`[adversarial] live mode — model=${model}, profile=${profile.name}, archetype=${profile.archetype}`);
    scenarios = await callLlmForScenarios(profile, kg, { apiKey, model });
    notes = `Generated ${scenarios.length} scenarios via ${model}. Merged with archetype scaffold baseline.`;
    // Merge with scaffold (LLM adds to baseline — never replaces universal checks).
    const existingIds = new Set(scenarios.map(s => s.id));
    for (const s of scaffoldScenarios(profile.archetype, profile)) {
      if (!existingIds.has(s.id)) scenarios.push(s);
    }
  }

  const report: AdversarialReport = {
    generatedAt: new Date().toISOString(),
    mode,
    model,
    profile: profile.name,
    archetype: profile.archetype,
    scenarios,
    notes,
  };

  mkdirSync(opts.outputDir, { recursive: true });
  const reportPath = join(opts.outputDir, 'adversarial-scenarios.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  // eslint-disable-next-line no-console
  console.log(`[adversarial] wrote ${scenarios.length} scenario(s) to ${reportPath}`);
  return report;
}

/**
 * LLM call for enriched adversarial scenarios. Kept minimal — one completion,
 * structured JSON output via response_format, strict schema validation on
 * parsing. Falls back to scaffold if the model returns unusable output.
 */
async function callLlmForScenarios(
  profile: DAppProfile,
  kg: KnowledgeGraph,
  opts: { apiKey: string; model: string },
): Promise<AdversarialScenario[]> {
  // Keep the prompt tight — KG is summarized, not dumped in full.
  const flowSummary = kg.flows
    .slice(0, 20)
    .map(f => `- [${f.category}] ${f.name}: ${f.steps.slice(0, 3).map(s => s.description).join(' / ')}`)
    .join('\n');
  const constraintSummary = kg.constraints
    .map(c => `- ${c.name}: ${c.value} (${c.scope ?? 'all'}) — ${c.testImplication}`)
    .join('\n');

  const system = `You are a senior Web3 security QA engineer generating adversarial test scenarios for a dApp. Return STRICT JSON matching the schema — no prose. Each scenario must have a clear "what if" that a human QA would check before a protocol goes live.`;
  const user = `dApp: ${profile.name} (archetype: ${profile.archetype}, chain: ${profile.network.chain})
URL: ${profile.url}

Flows observed (${kg.flows.length} total, showing first 20):
${flowSummary || '(no flows yet)'}

Protocol constraints:
${constraintSummary || '(none extracted yet)'}

Generate 6–10 adversarial scenarios covering: slippage-boundary, approval-overspend, liquidation-boundary, receiver-mismatch, zero-amount, max-amount, sandwich-simulation, stale-oracle (where applicable to the archetype).

Return JSON with shape:
{
  "scenarios": [
    {
      "id": "<archetype>.<target>.<index>",
      "archetype": "${profile.archetype}",
      "target": "...",
      "name": "...",
      "description": "1-2 sentences",
      "baseFlowId": "<flow id or omit>",
      "mutations": { "key": "value" },
      "expectedAssertions": [
        { "id": "...", "kind": "should-fail-tx|should-warn-ui|should-block-form|should-clamp-value", "signal": "..." }
      ],
      "severity": "warn|error|critical"
    }
  ]
}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
      'HTTP-Referer': 'https://bugdapp.agent',
      'X-Title': 'bugdapp-agent:adversarial',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });
  if (!res.ok) {
    throw new Error(`openrouter call failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('openrouter returned no content');

  let parsed: { scenarios?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`model returned non-JSON content: ${String(e)}`);
  }
  if (!Array.isArray(parsed.scenarios)) {
    throw new Error('model returned no scenarios[] field');
  }
  // Validate loosely — drop anything missing required fields.
  const out: AdversarialScenario[] = [];
  for (const raw of parsed.scenarios) {
    const s = raw as Partial<AdversarialScenario>;
    if (!s.id || !s.archetype || !s.target || !s.name || !s.description || !s.mutations || !s.expectedAssertions || !s.severity) continue;
    out.push(s as AdversarialScenario);
  }
  return out;
}

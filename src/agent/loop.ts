/**
 * Executor agent — act-observe loop for Avantis tasks.
 *
 * Model: OpenRouter, default anthropic/claude-sonnet-4.5 (env override EXECUTOR_MODEL).
 * Reasoning: best tool-use reliability on noisy DOM. Haiku 4.5 is a budget fallback.
 *
 * Budget caps (hard, hard-coded):
 *   - Max iterations: 20
 *   - Max tokens: 100,000
 *   - Max wall time: 8 min
 * Any cap → abort with partial trace.
 */
import { createOpenRouterClient, type MessageParam, type ContentBlock } from '../core/llm.js';
import { routeToolCall, allToolDefs } from './tool-router.js';
import { dAppContextPrompt } from './prompts.js';
import { thinKnowledge, contextForUrl } from './knowledge.js';
import { getOrLaunchSession, installExitHooks } from './session.js';
import { activeDApp, type ActiveDApp } from '../config.js';
import type { BrowserCtx } from '../types.js';

const EXECUTOR_MODEL = process.env.EXECUTOR_MODEL ?? 'anthropic/claude-sonnet-4.5';
const MAX_ITERATIONS = 20;
const MAX_TOKENS_BUDGET = 100_000;
const MAX_WALL_TIME_MS = 8 * 60 * 1000;

export interface ExecutorTaskInput {
  task: string;
  initialUrl?: string;
  /** Optional explicit dApp; if omitted, resolved from DAPP_URL env via config. */
  dapp?: ActiveDApp;
}

export interface ExecutorStep {
  iteration: number;
  tool: string;
  input: Record<string, unknown>;
  success: boolean;
  output: string;
  /** Playwright-equivalent code line for this action (empty for no-op tools like snapshot). */
  code?: string;
  durationMs: number;
}

export interface ExecutorResult {
  outcome: 'complete' | 'failed' | 'aborted';
  summary: string;
  terminalState?: string;
  txHash?: string;
  steps: ExecutorStep[];
  tokensUsed: number;
  /** Tokens read from Anthropic's ephemeral cache (cheap). */
  cacheReadTokens: number;
  /** Tokens written into the cache on first use (one-time cost). */
  cacheCreationTokens: number;
  durationMs: number;
  model: string;
  abortReason?: 'max_iterations' | 'max_tokens' | 'max_wall_time' | 'error';
}

export type StepListener = (step: ExecutorStep) => void | Promise<void>;

/**
 * System prompt is returned as an array of text blocks so we can mark the
 * stable portion (rules + profile + overview) as cacheable. The agent-loop
 * sends these through OpenRouter → Anthropic with `cache_control: ephemeral`
 * so subsequent turns pay cache-read rates instead of full input rates (5-10x
 * cost reduction on repeated system prompts per Anthropic's published numbers).
 */
function systemPromptBlocks(dapp: ActiveDApp, overview: string): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> {
  const rules = [
    'You are the executor agent of bugdapp-agent, a Web3 QA system. Your job is to drive a real Chromium browser with a MetaMask test wallet to carry out a single user task on a live dApp, then either complete or fail with evidence.',
    '',
    'You have browser tools (browser_*), wallet tools (wallet_*), and control tools (task_complete, task_failed). The dApp knowledge is organized into modules — `get_module_context` retrieves a module\'s detailed doc on demand; the initial overview below lists all modules.',
    '',
    'Operating rules:',
    '1. Always call browser_snapshot at the start and after any navigation or major state change — the snapshot returns element refs (e.g. [ref=e5]) that subsequent browser_click / browser_type calls consume.',
    '2. Prefer clicking by ref from a fresh snapshot over typing selectors.',
    '3. Wallet popups: after any action that triggers MetaMask (connect / sign / send tx / switch network), call the matching wallet_* tool to approve or reject. Do not expect the browser to auto-dismiss MM.',
    '4. If a click should produce a tx, wait for confirmation. If a tx hash is visible, capture it for wallet_verify_tx.',
    '5. Never invent refs. If a ref from an earlier snapshot is stale (page changed), take a new snapshot.',
    '6. If the state classifier or a CTA label indicates a blocker (insufficient balance, wrong network, unconnected), call task_failed with a clear reason — do not loop trying to brute-force past it.',
    '7. Be terse. Each assistant turn should be a short plan of the next 1–2 actions, then the tool call. No essays.',
    '8. Module context: when operating on a module for the first time, call `get_module_context` to load its .md with components/docs/constraints/entry points. The module markdown is ground truth — trust it over assumptions. After browser_navigate, module context for the new URL is auto-injected in the next observation.',
    '9. ON-CHAIN VERIFICATION — REQUIRED when a transaction was submitted: after wallet_confirm_transaction, capture the tx hash from the UI. Then call wallet_verify_tx with that hash. Only call task_complete after you see status:"success" AND a meaningful event (e.g. PositionOpened, Transfer, Swap). If reverted or expected event missing, task_failed with decoded reason.',
    '',
    dAppContextPrompt(dapp),
    '',
    overview,
  ].join('\n');
  return [{ type: 'text', text: rules, cache_control: { type: 'ephemeral' } }];
}

async function takeInitialSnapshot(ctx: BrowserCtx): Promise<string> {
  const res = await routeToolCall('browser_snapshot', {}, ctx);
  return res.output;
}

export async function runExecutor(
  input: ExecutorTaskInput,
  onStep: StepListener = () => {},
): Promise<ExecutorResult> {
  installExitHooks();
  const started = Date.now();
  const steps: ExecutorStep[] = [];
  let tokensUsed = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  const dapp = input.dapp ?? activeDApp();
  const initialUrl = input.initialUrl ?? dapp.url;
  const { overview } = thinKnowledge(dapp);
  const initialContext = contextForUrl(initialUrl, dapp);
  const ctx = await getOrLaunchSession(initialUrl);

  const firstSnapshot = await takeInitialSnapshot(ctx);

  const client = createOpenRouterClient(process.env.OPENROUTER_API_KEY);
  const tools = allToolDefs();

  // Bootstrap the first user turn with: task + any module .md(s) whose pages match
  // the landing URL + the DOM snapshot. This seeds the agent with relevant RAG
  // context without paying for it every turn.
  const initialModuleBlock = initialContext.length > 0
    ? '\n\n# CURRENT PAGE MODULE CONTEXT (RAG-retrieved)\n' +
      initialContext.map(c => `## Module: ${c.moduleName}\n\n${c.content}`).join('\n\n---\n\n')
    : '';

  const messages: MessageParam[] = [
    {
      role: 'user',
      content: `TASK: ${input.task}${initialModuleBlock}\n\n# CURRENT PAGE SNAPSHOT\n${truncate(firstSnapshot, 3000)}\n\nProceed.`,
    },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (Date.now() - started > MAX_WALL_TIME_MS) {
      return finalize('aborted', 'Max wall time exceeded', 'max_wall_time');
    }
    if (tokensUsed > MAX_TOKENS_BUDGET) {
      return finalize('aborted', 'Token budget exceeded', 'max_tokens');
    }

    let resp;
    try {
      resp = await client.messages.create({
        model: EXECUTOR_MODEL,
        max_tokens: 2048,
        temperature: 0,
        system: systemPromptBlocks(dapp, overview),
        tools,
        messages,
      });
    } catch (e: any) {
      return finalize('aborted', `LLM call failed: ${e?.message ?? e}`, 'error');
    }

    tokensUsed += (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0);
    cacheReadTokens += resp.usage?.cache_read_input_tokens ?? 0;
    cacheCreationTokens += resp.usage?.cache_creation_input_tokens ?? 0;

    messages.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter((b: ContentBlock) => b.type === 'tool_use') as Array<Extract<ContentBlock, { type: 'tool_use' }>>;
    if (toolUses.length === 0) {
      return finalize('aborted', 'LLM stopped without calling task_complete or task_failed', 'error');
    }

    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
    for (const call of toolUses) {
      const stepStart = Date.now();
      const outcome = await routeToolCall(call.name, call.input, ctx);
      const step: ExecutorStep = {
        iteration: i,
        tool: call.name,
        input: call.input,
        success: outcome.success,
        output: outcome.output,
        code: outcome.code,
        durationMs: Date.now() - stepStart,
      };
      steps.push(step);
      try { await onStep(step); } catch {}

      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: truncate(outcome.output, 4000),
        is_error: !outcome.success,
      });

      if (outcome.terminal) {
        return finalize(
          outcome.terminal.kind,
          outcome.terminal.summary,
          undefined,
          outcome.terminal.terminalState,
          outcome.terminal.txHash,
        );
      }
    }

    messages.push({ role: 'user', content: toolResults as any });
  }

  return finalize('aborted', 'Max iterations reached without completing the task', 'max_iterations');

  function finalize(
    outcome: ExecutorResult['outcome'],
    summary: string,
    abortReason?: ExecutorResult['abortReason'],
    terminalState?: string,
    txHash?: string,
  ): ExecutorResult {
    return {
      outcome, summary, abortReason, terminalState, txHash,
      steps, tokensUsed, cacheReadTokens, cacheCreationTokens,
      durationMs: Date.now() - started,
      model: EXECUTOR_MODEL,
    };
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}

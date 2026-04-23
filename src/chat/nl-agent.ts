/**
 * Natural-language chat agent. Avantis-only (for now).
 *
 * Two layers:
 *   1. intent parser — single cheap LLM call → { type, task?, ... }
 *   2. task pipeline — match to spec / generate plan / run executor / report
 *
 * The approval gate lives in handler.ts (setPending / classifyReply), unchanged.
 */
import { createOpenRouterClient } from '../llm/openrouter.js';
import { avantisProfile } from '../agent/profiles/avantis.js';
import { listAvantisSpecs } from './agent/spec-matcher.js';

const NL_MODEL = process.env.CHAT_MODEL ?? 'deepseek/deepseek-chat';

export type Intent =
  | { type: 'task'; task: string }
  | { type: 'list' }
  | { type: 'status' }
  | { type: 'help' }
  | { type: 'smalltalk'; reply: string }
  | { type: 'unknown'; reply: string };

const SYSTEM_PROMPT = [
  'You are the intent parser for bugdapp-agent, a Web3 QA agent that currently supports ONE dApp: Avantis (perpetual futures on Base, https://developer.avantisfi.com).',
  '',
  'Your job: classify a user message into one of these intents and return STRICT JSON.',
  '',
  'Intents:',
  '- `task`   — user wants the agent to DO something on Avantis (e.g. open a long, close a position, check a flow, test something). Field: `task` = the user\'s instruction, minimally cleaned.',
  '- `list`   — user asks what the agent can do / which dApps / which flows.',
  '- `status` — user asks about active/pending runs.',
  '- `help`   — user asks for help / commands.',
  '- `smalltalk` — user greeting / thanks / unrelated chit-chat. Field: `reply` = short response.',
  '- `unknown` — user asks for something outside Avantis QA. Field: `reply` = short explanation of what the agent does.',
  '',
  'Rules:',
  '- The agent only supports Avantis today. If the user asks about another dApp, return `unknown` with a brief pointer that only Avantis is supported.',
  '- If the user says something like "run the test", "do that again", "retry" without context — return `task` with task="rerun last task" and let the pipeline decide.',
  '- For `task`, keep the task text close to what the user said — don\'t paraphrase into formal English, just clean grammar.',
  '',
  'Return ONLY JSON. No prose.',
].join('\n');

export async function parseIntent(userMessage: string): Promise<Intent> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Degraded path: keyword heuristic
    return heuristicIntent(userMessage);
  }
  try {
    const client = createOpenRouterClient(apiKey);
    const resp = await client.messages.create({
      model: NL_MODEL,
      max_tokens: 300,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    const text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
    const json = extractJson(text);
    if (!json || typeof json.type !== 'string') return heuristicIntent(userMessage);
    return normalizeIntent(json, userMessage);
  } catch {
    return heuristicIntent(userMessage);
  }
}

function normalizeIntent(json: any, raw: string): Intent {
  switch (json.type) {
    case 'task': {
      const task = typeof json.task === 'string' && json.task.trim() ? json.task.trim() : raw.trim();
      return { type: 'task', task };
    }
    case 'list': return { type: 'list' };
    case 'status': return { type: 'status' };
    case 'help': return { type: 'help' };
    case 'smalltalk':
      return { type: 'smalltalk', reply: String(json.reply ?? "I'm here. Ask me to test something on Avantis.") };
    default:
      return { type: 'unknown', reply: String(json.reply ?? "I run Avantis QA tasks. Try: 'open a 25x long on ETH-USD'.") };
  }
}

function heuristicIntent(msg: string): Intent {
  const t = msg.toLowerCase().trim();
  if (!t) return { type: 'unknown', reply: 'Say something.' };
  if (/^(help|\?|commands?)$/.test(t)) return { type: 'help' };
  if (/^(list|dapps|flows|what can you do)/.test(t)) return { type: 'list' };
  if (/^status$/.test(t)) return { type: 'status' };
  if (/^(hi|hello|hey|thanks|thank you|ty)\b/.test(t)) {
    return { type: 'smalltalk', reply: "Hi — ask me to test something on Avantis (e.g. 'open a 25x long on ETH-USD')." };
  }
  if (/(test|run|check|open|close|verify|try|do|audit)/.test(t)) {
    return { type: 'task', task: msg.trim() };
  }
  return { type: 'unknown', reply: "I run QA tasks on Avantis. Try 'open a long on ETH-USD' or 'close my position'." };
}

function extractJson(s: string): any | null {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

export function listFlowsReply(): string {
  const specs = listAvantisSpecs();
  const head = `**Avantis (${avantisProfile.url})** — the only dApp supported today.`;
  const profileLines = [
    `- Network: ${avantisProfile.network.chain} (chainId ${avantisProfile.network.chainId})`,
    `- Archetype: ${avantisProfile.archetype}`,
    `- Min position: $${avantisProfile.values.minPositionSizeUsd}`,
    `- Typical test: $${avantisProfile.values.preferredAmountUsd} collateral × ${avantisProfile.values.targetLeverage}x`,
  ].join('\n');
  const specBlock = specs.length === 0
    ? '**No cached specs on disk** — I\'ll drive the browser myself (act mode).'
    : `**Known specs (${specs.length}):**\n${specs.slice(0, 20).map(s => '• `' + s + '`').join('\n')}${specs.length > 20 ? '\n…' : ''}`;
  const examples = [
    '**Try asking me:**',
    '• "open a 25x long on ETH-USD with $25 collateral"',
    '• "close my ETH-USD position"',
    '• "check if the trade form shows a min-amount error below $500"',
    '• "run `perps-primary` spec"',
  ].join('\n');
  return [head, profileLines, '', specBlock, '', examples].join('\n');
}

export function helpReply(): string {
  return [
    '**bugdapp-agent** — Avantis QA agent',
    'Describe what you want tested. I\'ll propose a plan, you approve with `go` / `no`, and I run it.',
    '',
    'Examples:',
    '• `open a long on ETH-USD`',
    '• `close position and verify portfolio updates`',
    '• `test what happens if I try to open with $10 collateral` (expected: min-amount error)',
    '• `list` — show what\'s available',
    '• `status` — active runs',
  ].join('\n');
}

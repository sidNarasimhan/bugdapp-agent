/**
 * Transport-agnostic message handler. CLI + Discord + Slack all call this.
 *
 * Flow:
 *   user message
 *     → if pending approval: classify 'go'/'no'
 *     → else: parseIntent (LLM) → route
 *   task intent:
 *     → matchTaskToSpec → plan text → set pending → post
 *   approval:
 *     → spec mode: heal-runner (Playwright + agent self-heal + verify)
 *     → act mode:  run executor agent (act-observe loop)
 *     → on failure: file Notion page with step trace
 */
import { fileAgentFinding, fileHealFinding, notionConfigured } from './notion.js';
import { setPending, getPending, clearPending, classifyReply, key as pendingKey, type Pending, type PendingInput } from './approvals.js';
import { parseIntent, listFlowsReply, helpReply } from './intent.js';
import { matchTaskToSpec } from './matcher.js';
import { runExecutor, type ExecutorResult, type ExecutorStep } from '../agent/loop.js';
import { runSuiteWithHealing, formatHealSummary, type HealRunSummary } from '../pipeline/heal-runner.js';
import { activeDApp } from '../config.js';

export interface ReplyFns {
  reply: (msg: string) => Promise<void>;
  progress?: (msg: string) => Promise<void>;
}

export interface Identity {
  platform: 'discord' | 'slack' | 'cli';
  userId: string;
  channelId: string;
}

const activeRuns = new Map<string, number>();

export async function handleMessage(text: string, id: Identity, io: ReplyFns): Promise<void> {
  const k = pendingKey(id.platform, id.userId, id.channelId);

  const pending = getPending(k);
  if (pending) {
    const verdict = classifyReply(text);
    if (verdict === 'approve') {
      clearPending(k);
      await io.reply(`✅ approved — executing...`);
      return executePending(pending, io);
    }
    if (verdict === 'reject') {
      clearPending(k);
      return io.reply(`🛑 cancelled.`);
    }
  }

  const intent = await parseIntent(text);
  switch (intent.type) {
    case 'help':       return io.reply(helpReply());
    case 'list':       return io.reply(listFlowsReply());
    case 'status':     return replyStatus(io);
    case 'smalltalk':  return io.reply(intent.reply);
    case 'unknown':    return io.reply(intent.reply);
    case 'task':       return handleTask(intent.task, k, io);
  }
}

async function replyStatus(io: ReplyFns): Promise<void> {
  if (activeRuns.size === 0) return io.reply('No active runs.');
  const now = Date.now();
  const lines = [...activeRuns.entries()]
    .map(([n, t]) => `• **${n}** — ${((now - t) / 1000).toFixed(0)}s`).join('\n');
  return io.reply(`**Active:**\n${lines}`);
}

async function handleTask(task: string, k: string, io: ReplyFns): Promise<void> {
  const dapp = activeDApp();
  const match = await matchTaskToSpec(task, dapp);

  let planText: string;
  let pending: PendingInput;

  if (match.mode === 'spec' && match.specFile) {
    pending = { kind: 'spec', dAppName: dapp.name, specFile: match.specFile, task };
    planText = [
      `**Plan — spec mode**`,
      `Matched to spec: \`${match.specFile}\``,
      match.confidence !== undefined ? `Confidence: ${Math.round(match.confidence * 100)}%` : '',
      `I'll run Playwright. If it fails I'll take over, recover, and heal the .spec.ts so next run is cheap.`,
      match.reason ? `_${match.reason}_` : '',
    ].filter(Boolean).join('\n');
  } else {
    pending = { kind: 'act', dAppName: dapp.name, task };
    planText = [
      `**Plan — act mode (browser agent)**`,
      `Task: ${task}`,
      `I'll drive Chromium + MetaMask via ${process.env.EXECUTOR_MODEL ?? 'anthropic/claude-sonnet-4.5'}.`,
      `Budget: 20 steps, 100k tokens, 8 min. Est ~$0.15–0.40.`,
      match.reason ? `_${match.reason}_` : '',
    ].filter(Boolean).join('\n');
  }

  setPending(k, pending);
  await io.reply(`${planText}\n\n→ reply \`go\` to run, \`no\` to cancel (expires in 10 min).`);
}

async function executePending(p: Pending, io: ReplyFns): Promise<void> {
  if (p.kind === 'spec') return executeSpec(p, io);
  return executeAct(p, io);
}

async function executeSpec(p: Extract<Pending, { kind: 'spec' }>, io: ReplyFns): Promise<void> {
  const name = `${p.dAppName}/${p.specFile}`;
  if (activeRuns.has(name)) return io.reply(`⏳ already running.`);
  activeRuns.set(name, Date.now());
  try {
    const progressBuf: string[] = [];
    let lastEmit = 0;
    const flush = async () => {
      if (progressBuf.length === 0) return;
      const chunk = progressBuf.splice(0, progressBuf.length).join('\n').slice(0, 1800);
      if (io.progress) await io.progress('```\n' + chunk + '\n```');
    };
    const summary = await runSuiteWithHealing({
      specFilter: `tests/${p.specFile}`,
      verifyAfterHeal: true,
      onLine: (line: string) => {
        progressBuf.push(line);
        const now = Date.now();
        if (now - lastEmit > 3500 || progressBuf.join('\n').length > 1500) {
          lastEmit = now;
          flush();
        }
      },
    });
    await flush();
    await io.reply('```\n' + formatHealSummary(summary) + '\n```');
    await maybeFileHealFindings(summary, p.task, io);
  } finally {
    activeRuns.delete(name);
  }
}

async function executeAct(p: Extract<Pending, { kind: 'act' }>, io: ReplyFns): Promise<void> {
  const name = `${p.dAppName}/act/${p.task.slice(0, 30)}`;
  if (activeRuns.has(name)) return io.reply(`⏳ already running.`);
  activeRuns.set(name, Date.now());
  try {
    const progressBuf: string[] = [];
    let lastEmit = 0;
    const flush = async () => {
      if (progressBuf.length === 0) return;
      const chunk = progressBuf.splice(0, progressBuf.length).join('\n').slice(0, 1800);
      if (io.progress) await io.progress('```\n' + chunk + '\n```');
    };
    const onStep = async (step: ExecutorStep) => {
      const head = step.success ? '✓' : '✗';
      const argPreview = summarizeInput(step.input);
      const outPreview = step.output.split('\n').slice(0, 2).join(' ').slice(0, 160);
      progressBuf.push(`${head} step ${step.iteration}: ${step.tool}${argPreview} — ${outPreview}`);
      const now = Date.now();
      if (now - lastEmit > 3500 || progressBuf.join('\n').length > 1500) {
        lastEmit = now;
        flush();
      }
    };

    await io.reply(`▶️  starting browser agent — real Chromium window opening on bot host.`);
    let result: ExecutorResult;
    try {
      result = await runExecutor({ task: p.task }, onStep);
    } catch (e: any) {
      await flush();
      await io.reply(`💥 executor crashed: ${e?.message ?? e}`);
      return;
    }
    await flush();
    await io.reply(formatExecutorSummary(result, p.task));
    await maybeFileActFinding(result, p.task, io);
  } finally {
    activeRuns.delete(name);
  }
}

function summarizeInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  const first = keys[0];
  const v = String(input[first] ?? '');
  return ` ${first}="${v.slice(0, 40)}${v.length > 40 ? '…' : ''}"`;
}

function formatExecutorSummary(r: ExecutorResult, task: string): string {
  const emoji = r.outcome === 'complete' ? '✅' : r.outcome === 'aborted' ? '⚠️' : '❌';
  const head = `${emoji} **${r.outcome}** (${r.steps.length} steps · ${(r.durationMs / 1000).toFixed(1)}s · ~${Math.round(r.tokensUsed / 1000)}k tok)`;
  const body = [
    `Task: _${task}_`,
    r.summary ? `Summary: ${r.summary}` : '',
    r.terminalState ? `Terminal state: \`${r.terminalState}\`` : '',
    r.txHash ? `Tx: \`${r.txHash}\`` : '',
    r.abortReason ? `Aborted: ${r.abortReason}` : '',
  ].filter(Boolean).join('\n');
  return `${head}\n${body}`;
}

async function maybeFileHealFindings(s: HealRunSummary, task: string, io: ReplyFns): Promise<void> {
  if (s.healed.length === 0 && s.unhealed.length === 0) return;
  if (!notionConfigured()) {
    return io.reply(`ℹ️  Notion not configured — skipping findings.`);
  }
  const urls: string[] = [];
  for (const item of [...s.healed, ...s.unhealed]) {
    const url = await fileHealFinding({ task, item });
    if (url) urls.push(url);
  }
  if (urls.length) {
    await io.reply(`📝 filed ${urls.length} finding(s):\n${urls.slice(0, 5).map(u => `• ${u}`).join('\n')}`);
  }
}

async function maybeFileActFinding(r: ExecutorResult, task: string, io: ReplyFns): Promise<void> {
  if (r.outcome === 'complete') return;
  if (!notionConfigured()) return io.reply(`ℹ️  Notion not configured — skipping report.`);
  const dapp = activeDApp();
  const url = await fileAgentFinding({
    dApp: dapp.name,
    archetype: dapp.archetype,
    url: dapp.url,
    task,
    result: r,
  });
  if (url) await io.reply(`📝 filed: ${url}`);
  else await io.reply(`⚠️  Notion filing failed (check token + DB schema).`);
}

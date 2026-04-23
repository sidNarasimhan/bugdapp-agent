/**
 * Transport-agnostic command handler. Discord and Slack bots both call this.
 *
 * Flow:
 *   user message → parse → (if run command) generate plan → post plan + await approval
 *   user reply "go" → run dispatcher → stream progress → post summary → file Notion pages
 *   user reply "no" → cancel
 *
 * Approval state is kept in-memory keyed by (platform, userId, channelId).
 */
import { parseCommand, helpText, type Command } from './commands.js';
import { runDApp, formatSummary, type RunResult } from './dispatcher.js';
import { fileFinding, notionConfigured } from '../integrations/notion.js';
import { PROFILES } from '../agent/profiles/registry.js';
import { buildPlanContext, generatePlan } from './planner.js';
import { setPending, getPending, clearPending, classifyReply, key as pendingKey } from './approvals.js';

export interface ReplyFns {
  reply: (msg: string) => Promise<void>;
  progress?: (msg: string) => Promise<void>;
}

export interface Identity {
  platform: 'discord' | 'slack';
  userId: string;
  channelId: string;
}

const activeRuns = new Map<string, number>();

export async function handleMessage(text: string, id: Identity, io: ReplyFns): Promise<void> {
  const k = pendingKey(id.platform, id.userId, id.channelId);

  // Approval reply?
  const pending = getPending(k);
  if (pending) {
    const verdict = classifyReply(text);
    if (verdict === 'approve') {
      clearPending(k);
      await io.reply(`✅ approved — running **${pending.dApp.name}** (${pending.filter})`);
      return executeRun(pending.dApp, pending.filter, io);
    }
    if (verdict === 'reject') {
      clearPending(k);
      await io.reply(`🛑 cancelled.`);
      return;
    }
    // Unclear reply while pending: fall through and re-parse as new command.
    // If it's a new run command, overwrite pending.
  }

  const cmd = parseCommand(text);
  await dispatch(cmd, id, io);
}

async function dispatch(cmd: Command, id: Identity, io: ReplyFns): Promise<void> {
  switch (cmd.kind) {
    case 'help':
      return io.reply(helpText());

    case 'list': {
      const lines = PROFILES
        .map(p => `• **${p.name}** — ${p.archetype} on ${p.network.chain} — ${p.url}`)
        .join('\n');
      return io.reply(`**Available dApps:**\n${lines}`);
    }

    case 'status': {
      if (activeRuns.size === 0) return io.reply('No active runs.');
      const now = Date.now();
      const lines = [...activeRuns.entries()]
        .map(([n, t]) => `• **${n}** — ${((now - t) / 1000).toFixed(0)}s`).join('\n');
      return io.reply(`**Active:**\n${lines}`);
    }

    case 'unknown':
      return io.reply(`❓ couldn't parse: \`${cmd.input}\`${cmd.hint ? ` (${cmd.hint})` : ''}\nTry \`help\`.`);

    case 'run': {
      const k = pendingKey(id.platform, id.userId, id.channelId);
      const ctx = buildPlanContext(cmd.dApp, cmd.filter);
      const plan = await generatePlan(ctx);

      if (!ctx.hasCachedCrawl || ctx.matchedSpecs.length === 0) {
        // Blocker surfaced inside plan text — don't stage an approval
        return io.reply(plan);
      }

      setPending(k, { dApp: cmd.dApp, filter: cmd.filter });
      await io.reply(`${plan}\n\n→ reply \`go\` to run, \`no\` to cancel (expires in 10 min).`);
      return;
    }
  }
}

async function executeRun(dApp: any, filter: any, io: ReplyFns): Promise<void> {
  const name = dApp.name;
  if (activeRuns.has(name)) {
    return io.reply(`⏳ **${name}** already running.`);
  }
  activeRuns.set(name, Date.now());
  try {
    const progressBuf: string[] = [];
    let lastEmit = 0;
    const flush = async () => {
      if (progressBuf.length === 0) return;
      const chunk = progressBuf.splice(0, progressBuf.length).join('\n').slice(0, 1800);
      if (io.progress) await io.progress('```\n' + chunk + '\n```');
    };
    const result = await runDApp(dApp, filter, (line) => {
      progressBuf.push(line);
      const now = Date.now();
      if (now - lastEmit > 3500 || progressBuf.join('\n').length > 1500) {
        lastEmit = now;
        flush();
      }
    });
    await flush();
    await io.reply(formatSummary(result));
    await maybeFileFindings(result, io);
  } finally {
    activeRuns.delete(name);
  }
}

async function maybeFileFindings(r: RunResult, io: ReplyFns): Promise<void> {
  if (r.summary.failures.length === 0) return;
  if (!notionConfigured()) {
    await io.reply(`ℹ️  ${r.summary.failures.length} failure(s) — Notion not configured (set \`NOTION_TOKEN\` + \`NOTION_DATABASE_ID\` in .env).`);
    return;
  }
  const p = PROFILES.find(x => x.name === r.dApp);
  const archetype = p?.archetype ?? 'unknown';
  const urls: string[] = [];
  for (const f of r.summary.failures) {
    const url = await fileFinding({
      dApp: r.dApp, archetype, url: r.url, outputDir: r.outputDir, failure: f,
    });
    if (url) urls.push(url);
  }
  if (urls.length) {
    await io.reply(`📝 filed ${urls.length} finding(s) to Notion:\n${urls.slice(0, 5).map(u => `• ${u}`).join('\n')}`);
  } else {
    await io.reply(`⚠️  failed to file any findings (check NOTION_TOKEN + DB sharing + schema).`);
  }
}

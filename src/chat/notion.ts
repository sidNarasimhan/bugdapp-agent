/**
 * Notion integration — creates pages in the configured DB for agent findings
 * and heal-run outcomes.
 *
 * DB schema (create in Notion, share with your integration):
 *   - Title     (title)
 *   - dApp      (select)
 *   - Archetype (select)
 *   - Status    (select)          // Completed / Aborted / Failed / Healed / Unhealed
 *   - Mode      (select)          // act / spec
 *   - Task      (rich_text)
 *   - Spec      (rich_text)
 *   - Error     (rich_text)
 *   - URL       (url)
 *   - Ran at    (date)
 *
 * Env: NOTION_TOKEN, NOTION_DATABASE_ID.
 */
import { Client } from '@notionhq/client';
import type { ExecutorResult, ExecutorStep } from '../agent/loop.js';

let _client: Client | null = null;
function client(): Client | null {
  const token = process.env.NOTION_TOKEN;
  if (!token) return null;
  if (!_client) _client = new Client({ auth: token });
  return _client;
}

export function notionConfigured(): boolean {
  return !!(process.env.NOTION_TOKEN && process.env.NOTION_DATABASE_ID);
}

export interface AgentFindingInput {
  dApp: string;
  archetype: string;
  url: string;
  task: string;
  result: ExecutorResult;
}

export async function fileAgentFinding(input: AgentFindingInput): Promise<string | null> {
  const notion = client();
  const db = process.env.NOTION_DATABASE_ID;
  if (!notion || !db) return null;

  const r = input.result;
  const statusName = r.outcome === 'complete' ? 'Completed' : r.outcome === 'aborted' ? 'Aborted' : 'Failed';
  const title = `${input.dApp}: ${input.task}`.slice(0, 200);
  const screenshots = collectScreenshots(r.steps);

  try {
    const resp = await notion.pages.create({
      parent: { database_id: db },
      properties: {
        Title: { title: [{ text: { content: title } }] },
        dApp: { select: { name: input.dApp } },
        Archetype: { select: { name: input.archetype } },
        Status: { select: { name: statusName } },
        Mode: { select: { name: 'act' } },
        Task: { rich_text: [{ text: { content: input.task.slice(0, 1800) } }] },
        Error: { rich_text: [{ text: { content: (r.summary || r.abortReason || 'n/a').slice(0, 1800) } }] },
        URL: { url: input.url },
        'Ran at': { date: { start: new Date().toISOString() } },
      },
      children: [
        h2('Summary'),
        para(r.summary || '(none)'),
        para(`Outcome: **${r.outcome}**${r.abortReason ? ` (${r.abortReason})` : ''} · model ${r.model} · ${r.steps.length} steps · ${(r.durationMs / 1000).toFixed(1)}s · ~${Math.round(r.tokensUsed / 1000)}k tokens`),
        ...(r.terminalState ? [para(`Terminal state: \`${r.terminalState}\``)] : []),
        ...(r.txHash ? [para(`Tx hash: \`${r.txHash}\``)] : []),
        h2('Step trace'),
        code(renderStepTrace(r.steps).slice(0, 1900)),
        ...(screenshots.length > 0 ? [h2('Screenshots'), ...screenshots.slice(0, 10).map(para)] : []),
      ],
    });
    return (resp as any).url ?? (resp as any).id ?? null;
  } catch (e: any) {
    console.warn(`[notion] fileAgentFinding failed: ${e?.message ?? e}`);
    return null;
  }
}

export interface HealFindingInput {
  task: string;
  item: {
    specFile: string;
    testTitle: string;
    backupPath?: string;
    ok?: boolean;
    reason?: string;
    agentOutcome?: string;
  };
}

export async function fileHealFinding(input: HealFindingInput): Promise<string | null> {
  const notion = client();
  const db = process.env.NOTION_DATABASE_ID;
  if (!notion || !db) return null;

  const healed = !!input.item.ok;
  const status = healed ? 'Healed' : 'Unhealed';
  const title = `${input.item.specFile}: ${input.item.testTitle}`.slice(0, 200);

  try {
    const resp = await notion.pages.create({
      parent: { database_id: db },
      properties: {
        Title: { title: [{ text: { content: title } }] },
        Status: { select: { name: status } },
        Mode: { select: { name: 'spec' } },
        Spec: { rich_text: [{ text: { content: input.item.specFile } }] },
        Task: { rich_text: [{ text: { content: input.task.slice(0, 1800) } }] },
        Error: { rich_text: [{ text: { content: (input.item.reason || input.item.agentOutcome || '').slice(0, 1800) } }] },
        'Ran at': { date: { start: new Date().toISOString() } },
      },
      children: [
        h2(healed ? 'Healed' : 'Unhealed'),
        para(`Spec: \`${input.item.specFile}\``),
        para(`Test: ${input.item.testTitle}`),
        ...(input.item.backupPath ? [para(`Backup: \`${input.item.backupPath}\``)] : []),
        ...(input.item.reason ? [para(`Reason: ${input.item.reason}`)] : []),
      ],
    });
    return (resp as any).url ?? (resp as any).id ?? null;
  } catch (e: any) {
    console.warn(`[notion] fileHealFinding failed: ${e?.message ?? e}`);
    return null;
  }
}

function renderStepTrace(steps: ExecutorStep[]): string {
  return steps.map(s => {
    const mark = s.success ? '✓' : '✗';
    const args = JSON.stringify(s.input).slice(0, 120);
    const out = s.output.split('\n')[0].slice(0, 140);
    return `${mark} [${s.iteration}] ${s.tool} ${args} — ${out}`;
  }).join('\n');
}

function collectScreenshots(steps: ExecutorStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (s.tool !== 'browser_screenshot') continue;
    const m = s.output.match(/Screenshot saved:\s*(.+)/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function h2(text: string): any {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: text } }] } };
}
function para(text: string): any {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: text.slice(0, 1900) } }] } };
}
function code(text: string): any {
  return { object: 'block', type: 'code', code: { language: 'plain text', rich_text: [{ text: { content: text } }] } };
}

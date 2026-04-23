/**
 * Notion integration — creates pages in the configured DB for test failures
 * (spec mode) or agent task outcomes (act mode).
 *
 * DB schema (create in Notion, share with your integration):
 *   - Title        (title)
 *   - dApp         (select)
 *   - Archetype    (select)          // perps/swap/lending/...
 *   - Status       (select)          // Failed / Aborted / Completed / Passed / Skipped
 *   - Mode         (select)          // spec / act
 *   - Spec         (rich_text)       // test file basename (spec mode)
 *   - Task         (rich_text)       // user task (act mode)
 *   - Error        (rich_text)       // short error/summary
 *   - URL          (url)             // dApp URL
 *   - Ran at       (date)
 *   - Artifacts    (rich_text)       // local path to output dir / screenshots
 *
 * Env: NOTION_TOKEN (internal integration secret), NOTION_DATABASE_ID.
 * The integration must be shared with the database (Share → Add connection).
 */
import { Client } from '@notionhq/client';
import type { TestFailure } from '../chat/dispatcher.js';
import type { ExecutorResult, ExecutorStep } from '../chat/agent/executor.js';

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

export interface FindingInput {
  dApp: string;
  archetype: string;
  url: string;
  outputDir: string;
  failure: TestFailure;
}

export async function fileFinding(input: FindingInput): Promise<string | null> {
  const notion = client();
  const db = process.env.NOTION_DATABASE_ID;
  if (!notion || !db) return null;

  const title = `${input.dApp}: ${input.failure.title}`.slice(0, 200);

  try {
    const resp = await notion.pages.create({
      parent: { database_id: db },
      properties: {
        Title: { title: [{ text: { content: title } }] },
        dApp: { select: { name: input.dApp } },
        Archetype: { select: { name: input.archetype } },
        Status: { select: { name: 'Failed' } },
        Mode: { select: { name: 'spec' } },
        Spec: { rich_text: [{ text: { content: input.failure.file.slice(0, 1800) } }] },
        Error: { rich_text: [{ text: { content: input.failure.error.slice(0, 1800) } }] },
        URL: { url: input.url },
        'Ran at': { date: { start: new Date().toISOString() } },
        Artifacts: { rich_text: [{ text: { content: input.outputDir.slice(0, 1800) } }] },
      },
      children: [
        blockH2('Error'),
        blockCode(input.failure.error.slice(0, 1900)),
        ...(input.failure.screenshot ? [blockPara(`Screenshot: ${input.failure.screenshot}`)] : []),
      ],
    });
    return (resp as any).url ?? (resp as any).id ?? null;
  } catch (e: any) {
    console.warn(`[notion] fileFinding failed: ${e?.message ?? e}`);
    return null;
  }
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
        Artifacts: { rich_text: [{ text: { content: (screenshots[0] ?? '').slice(0, 1800) } }] },
      },
      children: [
        blockH2('Summary'),
        blockPara(r.summary || '(none)'),
        blockPara(`Outcome: **${r.outcome}**${r.abortReason ? ` (${r.abortReason})` : ''} · model ${r.model} · ${r.steps.length} steps · ${(r.durationMs / 1000).toFixed(1)}s · ~${Math.round(r.tokensUsed / 1000)}k tokens`),
        ...(r.terminalState ? [blockPara(`Terminal state: \`${r.terminalState}\``)] : []),
        ...(r.txHash ? [blockPara(`Tx hash: \`${r.txHash}\``)] : []),
        blockH2('Step trace'),
        blockCode(renderStepTrace(r.steps).slice(0, 1900)),
        ...(screenshots.length > 0 ? [blockH2('Screenshots'), ...screenshots.slice(0, 10).map(blockPara)] : []),
      ],
    });
    return (resp as any).url ?? (resp as any).id ?? null;
  } catch (e: any) {
    console.warn(`[notion] fileAgentFinding failed: ${e?.message ?? e}`);
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

function blockH2(text: string): any {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: text } }] } };
}
function blockPara(text: string): any {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: text.slice(0, 1900) } }] } };
}
function blockCode(text: string): any {
  return { object: 'block', type: 'code', code: { language: 'plain text', rich_text: [{ text: { content: text } }] } };
}

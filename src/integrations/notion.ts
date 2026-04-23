/**
 * Notion integration — creates one page per test failure in the configured DB.
 *
 * DB schema (you create in Notion, then share with the integration):
 *   - Title        (title)
 *   - dApp         (select)
 *   - Archetype    (select)          // perps/swap/lending/...
 *   - Status       (select)          // Failed / Passed / Skipped
 *   - Spec         (rich_text)       // test file basename
 *   - Error        (rich_text)       // first 2000 chars of error
 *   - URL          (url)             // dApp URL
 *   - Ran at       (date)
 *   - Artifacts    (rich_text)       // local path to output dir
 *
 * Env: NOTION_TOKEN (internal integration secret), NOTION_DATABASE_ID.
 * The integration must be shared with the database (Notion → DB → Share → Add connection).
 */
import { Client } from '@notionhq/client';
import type { TestFailure } from '../chat/dispatcher.js';

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
        Spec: { rich_text: [{ text: { content: input.failure.file.slice(0, 1800) } }] },
        Error: { rich_text: [{ text: { content: input.failure.error.slice(0, 1800) } }] },
        URL: { url: input.url },
        'Ran at': { date: { start: new Date().toISOString() } },
        Artifacts: { rich_text: [{ text: { content: input.outputDir.slice(0, 1800) } }] },
      },
      children: [
        {
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: 'Error' } }] },
        },
        {
          object: 'block',
          type: 'code',
          code: {
            language: 'plain text',
            rich_text: [{ text: { content: input.failure.error.slice(0, 1900) } }],
          },
        },
        ...(input.failure.screenshot
          ? [{
              object: 'block' as const,
              type: 'paragraph' as const,
              paragraph: {
                rich_text: [{
                  text: { content: `Screenshot: ${input.failure.screenshot}` },
                }],
              },
            }]
          : []),
      ],
    });
    return (resp as any).url ?? (resp as any).id ?? null;
  } catch (e: any) {
    console.warn(`[notion] filing failed: ${e?.message ?? e}`);
    return null;
  }
}

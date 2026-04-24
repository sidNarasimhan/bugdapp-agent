/**
 * Spec healer — rewrites a failing .spec.ts file using a successful agent trace.
 *
 * Strategy:
 *   - Keep the file's imports, describe block, beforeEach (shared wallet connect).
 *   - Replace the specific failing test()'s body with new statements generated from
 *     the agent's `step.code` entries (Playwright code equivalents recorded by
 *     tool-router.ts).
 *   - Back up original to <file>.bak.<timestamp>.ts so you can git-diff / revert.
 *
 * The healed spec is deliberately simpler than the comprehension-generated one —
 * it captures what actually worked, not what the LLM *planned*. Next run is pure
 * Playwright (no LLM), fast and cheap.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import type { ExecutorStep } from '../agent/loop.js';

export interface HealResult {
  ok: boolean;
  specPath: string;
  backupPath?: string;
  replacedTestTitle?: string;
  linesInjected: number;
  reason?: string;
}

/**
 * Heal a specific failing test in a spec file.
 *
 * @param specPath      absolute path to the .spec.ts file
 * @param failingTitle  the title string used in test('<title>', ...) — matches exact substring
 * @param steps         agent's successful steps (must end in task_complete)
 */
export async function healSpec(
  specPath: string,
  failingTitle: string,
  steps: ExecutorStep[],
): Promise<HealResult> {
  let source: string;
  try { source = readFileSync(specPath, 'utf-8'); }
  catch (e: any) { return { ok: false, specPath, linesInjected: 0, reason: `read failed: ${e?.message ?? e}` }; }

  const match = findTestBlock(source, failingTitle);
  if (!match) return { ok: false, specPath, linesInjected: 0, reason: `test block with title containing "${failingTitle}" not found` };

  const newBody = renderAgentTrace(steps);
  if (!newBody.trim()) return { ok: false, specPath, linesInjected: 0, reason: 'agent trace produced zero actionable lines' };

  // Backup
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(dirname(specPath), `${basename(specPath, '.ts')}.bak.${ts}.ts`);
  try { copyFileSync(specPath, backupPath); }
  catch (e: any) { return { ok: false, specPath, linesInjected: 0, reason: `backup failed: ${e?.message ?? e}` }; }

  const replaced = source.slice(0, match.bodyStart) + '\n' + newBody + '\n  ' + source.slice(match.bodyEnd);
  try { writeFileSync(specPath, replaced, 'utf-8'); }
  catch (e: any) { return { ok: false, specPath, backupPath, linesInjected: 0, reason: `write failed: ${e?.message ?? e}` }; }

  const linesInjected = newBody.split('\n').length;
  return { ok: true, specPath, backupPath, replacedTestTitle: match.title, linesInjected };
}

// ---------- Internals ----------

interface TestBlockMatch {
  title: string;
  /** Offset in source immediately after the opening `{` of the test body. */
  bodyStart: number;
  /** Offset of the closing `}` that ends the test body (before the `)` of test()). */
  bodyEnd: number;
}

/**
 * Finds `test("<title>", async ({ page }) => { ... })` or `test("<title>", async (fixtures) => { ... })`
 * where `<title>` contains `needle`. Uses brace-matching, not regex, because test bodies have nested braces.
 */
function findTestBlock(source: string, needle: string): TestBlockMatch | null {
  const testRe = /test\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = testRe.exec(source)) !== null) {
    const title = m[2];
    if (!title.includes(needle)) continue;

    // Find the arrow function's opening `{` after the comma + async callback signature
    const afterTitle = testRe.lastIndex;
    const arrowIdx = source.indexOf('=>', afterTitle);
    if (arrowIdx < 0) continue;
    const openBrace = source.indexOf('{', arrowIdx);
    if (openBrace < 0) continue;

    // Brace-match
    let depth = 1;
    let i = openBrace + 1;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '"' || c === "'" || c === '`') {
        // skip string
        const quote = c;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') i += 2; else i++;
        }
        i++;
      } else if (c === '/' && source[i + 1] === '/') {
        // skip line comment
        i = source.indexOf('\n', i);
        if (i < 0) i = source.length;
      } else if (c === '/' && source[i + 1] === '*') {
        i = source.indexOf('*/', i + 2);
        if (i < 0) i = source.length; else i += 2;
      } else {
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
    }
    if (depth !== 0) continue;
    const closingBrace = i - 1;
    return { title, bodyStart: openBrace + 1, bodyEnd: closingBrace };
  }
  return null;
}

function renderAgentTrace(steps: ExecutorStep[]): string {
  const lines: string[] = [];
  lines.push('    // [healed] Rewritten from agent trace on ' + new Date().toISOString());
  lines.push('');

  for (const step of steps) {
    if (!step.success) continue;
    // task_complete / task_failed are control signals — reflect as comments + assertion
    if (step.tool === 'task_complete') {
      const summary = String(step.input?.summary ?? '').replace(/\*\//g, '* /');
      lines.push(`    // TASK COMPLETE: ${summary}`);
      if (step.input?.tx_hash) {
        const txHash = JSON.stringify(step.input.tx_hash);
        lines.push(`    expect(${txHash}).toMatch(/^0x[0-9a-fA-F]{64}$/);`);
      }
      continue;
    }
    if (step.tool === 'task_failed') {
      continue; // should not appear in a successful trace
    }
    if (!step.code) continue;

    // Indent each code line with 4 spaces
    for (const codeLine of step.code.split('\n')) {
      lines.push(`    ${codeLine}`);
    }
    // Small wait after wallet-triggering actions — realistic cushion
    if (step.tool.startsWith('wallet_')) {
      lines.push(`    await page.waitForTimeout(2000);`);
    }
  }

  return lines.join('\n');
}

import { join } from 'path';
import type { BrowserCtx, ToolDefinition, ToolCallResult, SnapshotRef } from '../types.js';

// ── Tool Definitions (passed to LLM) ──

export const browserToolDefs: ToolDefinition[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to' } }, required: ['url'] },
  },
  {
    name: 'browser_snapshot',
    description: 'Get an accessibility snapshot of the current page. Returns interactive elements with [ref=eN] identifiers that can be used with browser_click, browser_type, etc.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: 'Click an element identified by its ref from a snapshot',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from snapshot (e.g. "e5")' },
        description: { type: 'string', description: 'What you are clicking and why' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input element identified by ref',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref' },
        text: { type: 'string', description: 'Text to type' },
        clear: { type: 'boolean', description: 'Clear the field first (default: true)' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name for the screenshot file' } },
      required: ['name'],
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in the page context and return the result',
    input_schema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JavaScript to evaluate' } },
      required: ['expression'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a keyboard key (e.g. "Enter", "Escape", "Tab")',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key to press' } },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page up or down',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for text to appear on the page, or wait for a specified timeout',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for' },
        timeout: { type: 'number', description: 'Max wait in ms (default: 10000)' },
      },
    },
  },
];

// ── Snapshot Builder ──

function buildAccessibilitySnapshot(tree: any, refs: Map<string, SnapshotRef>): string {
  let refCounter = 0;

  function formatNode(node: any, depth: number): string {
    if (!node) return '';
    const ref = `e${++refCounter}`;
    refs.set(ref, { role: node.role, name: node.name || '' });

    let indent = '  '.repeat(depth);
    let line = `${indent}- [ref=${ref}] [${node.role}] "${node.name || ''}"`;
    if (node.value !== undefined && node.value !== '') line += ` value="${node.value}"`;
    if (node.checked !== undefined) line += ` checked=${node.checked}`;
    if (node.disabled) line += ` (disabled)`;
    let result = line + '\n';

    if (node.children) {
      for (const child of node.children) {
        result += formatNode(child, depth + 1);
      }
    }
    return result;
  }

  return formatNode(tree, 0);
}

async function buildDomSnapshot(page: any, refs: Map<string, SnapshotRef>): Promise<string> {
  const elements = await page.evaluate(() => {
    const selectors = 'button, a, input, select, textarea, [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"], [role="spinbutton"], [role="option"], [role="menuitem"], [role="link"], [role="button"]';
    const els = document.querySelectorAll(selectors);
    return Array.from(els).slice(0, 200).map((el: any) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name: (el.textContent?.trim().substring(0, 80) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''),
        testId: el.getAttribute('data-testid') || '',
        type: el.getAttribute('type') || '',
        value: el.value || '',
        checked: el.getAttribute('aria-checked') || (el.checked ? 'true' : undefined),
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      };
    }).filter(Boolean);
  }).catch(() => []);

  let refCounter = 0;
  let output = '';
  for (const el of elements) {
    const ref = `e${++refCounter}`;
    refs.set(ref, { role: el.role, name: el.name, testId: el.testId, tag: el.tag, type: el.type });
    let line = `- [ref=${ref}] [${el.role}] "${el.name}"`;
    if (el.testId) line += ` testid="${el.testId}"`;
    if (el.type) line += ` type=${el.type}`;
    if (el.value) line += ` value="${el.value}"`;
    if (el.checked) line += ` checked=${el.checked}`;
    if (el.disabled) line += ` (disabled)`;
    output += line + '\n';
  }
  return output;
}

// ── Locator Resolution ──

async function resolveRef(page: any, ref: string, refs: Map<string, SnapshotRef>): Promise<any> {
  const info = refs.get(ref);
  if (!info) throw new Error(`Unknown ref "${ref}". Take a new browser_snapshot first.`);

  // Try testid
  if (info.testId) {
    const loc = page.getByTestId(info.testId);
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) return loc;
  }

  // Try role + name
  if (info.role && info.name) {
    try {
      const loc = page.getByRole(info.role, { name: info.name }).first();
      if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) return loc;
    } catch {}
  }

  // Try text match
  if (info.name) {
    const loc = page.locator(`text="${info.name}"`).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) return loc;
  }

  // Try tag + text
  if (info.tag && info.name) {
    const loc = page.locator(`${info.tag}:has-text("${info.name}")`).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) return loc;
  }

  // Unnamed elements (switches, sliders, checkboxes) — resolve by role + index
  if (!info.name && info.role) {
    // Count how many elements with same role and no name appear before this ref
    let indexForRole = 0;
    for (const [r, rInfo] of refs) {
      if (r === ref) break;
      if (rInfo.role === info.role && !rInfo.name) indexForRole++;
    }
    try {
      const loc = page.getByRole(info.role).nth(indexForRole);
      if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) return loc;
    } catch {}

    // Also try by tag if role didn't work
    if (info.tag) {
      try {
        const loc = page.locator(info.tag).nth(indexForRole);
        if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) return loc;
      } catch {}
    }
  }

  throw new Error(`Could not locate element ref="${ref}" (${info.role} "${info.name}")`);
}

// ── Tool Executor ──

export async function executeBrowserTool(
  name: string,
  input: Record<string, unknown>,
  ctx: BrowserCtx,
): Promise<ToolCallResult> {
  const { page, snapshotRefs, screenshotDir } = ctx;

  try {
    switch (name) {
      case 'browser_navigate': {
        await page.goto(input.url as string, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
        const title = await page.title();
        return ok(`Navigated to ${input.url} — "${title}"`);
      }

      case 'browser_snapshot': {
        snapshotRefs.clear();
        let tree: string;

        try {
          const accTree = await (page as any).accessibility?.snapshot({ interestingOnly: true });
          if (accTree) {
            tree = buildAccessibilitySnapshot(accTree, snapshotRefs);
          } else {
            tree = await buildDomSnapshot(page, snapshotRefs);
          }
        } catch {
          tree = await buildDomSnapshot(page, snapshotRefs);
        }

        const url = page.url();
        const title = await page.title();
        return ok(`Page: ${url}\nTitle: ${title}\n\n${tree}`);
      }

      case 'browser_click': {
        const loc = await resolveRef(page, input.ref as string, snapshotRefs);
        await loc.click({ timeout: 10000 });
        return ok(`Clicked [ref=${input.ref}]${input.description ? ` — ${input.description}` : ''}`);
      }

      case 'browser_type': {
        const loc = await resolveRef(page, input.ref as string, snapshotRefs);
        if (input.clear !== false) {
          await loc.fill(input.text as string);
        } else {
          await loc.type(input.text as string);
        }
        return ok(`Typed "${input.text}" into [ref=${input.ref}]`);
      }

      case 'browser_screenshot': {
        const safeName = (input.name as string).replace(/[^a-zA-Z0-9_-]/g, '_');
        const filePath = join(screenshotDir, `${safeName}.png`);
        await page.screenshot({ path: filePath, fullPage: false });
        ctx.screenshotCounter++;
        return ok(`Screenshot saved: ${filePath}`);
      }

      case 'browser_evaluate': {
        const result = await page.evaluate(input.expression as string);
        return ok(JSON.stringify(result, null, 2));
      }

      case 'browser_press_key': {
        await page.keyboard.press(input.key as string);
        return ok(`Pressed key: ${input.key}`);
      }

      case 'browser_scroll': {
        const amount = (input.amount as number) || 500;
        const dir = input.direction === 'up' ? -amount : amount;
        await page.evaluate((y: number) => window.scrollBy(0, y), dir);
        return ok(`Scrolled ${input.direction} ${amount}px`);
      }

      case 'browser_wait': {
        if (input.text) {
          await page.locator(`text="${input.text}"`).first().waitFor({ timeout: (input.timeout as number) || 10000 });
          return ok(`Found text: "${input.text}"`);
        }
        await page.waitForTimeout((input.timeout as number) || 5000);
        return ok(`Waited ${(input.timeout as number) || 5000}ms`);
      }

      default:
        return fail(`Unknown browser tool: ${name}`);
    }
  } catch (e) {
    return fail(`${name} error: ${(e as Error).message}`);
  }
}

function ok(output: string): ToolCallResult {
  return { success: true, output };
}

function fail(output: string): ToolCallResult {
  return { success: false, output };
}

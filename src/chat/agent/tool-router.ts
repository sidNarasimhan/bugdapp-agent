/**
 * Routes tool calls from the agent loop to the correct executor.
 *
 * Reuses existing browser + wallet tool implementations:
 *   - src/browser/tools.ts       — browser_navigate, browser_snapshot, browser_click, ...
 *   - src/browser/wallet.ts      — wallet_approve_connection, wallet_sign, ...
 *
 * Adds agent-only control tools (task_complete / task_failed) and records a
 * Playwright code equivalent for every successful action — used by the
 * spec-healer to rewrite .spec.ts files from successful agent traces.
 */
import type { BrowserCtx, ToolDefinition, ToolCallResult, SnapshotRef } from '../../types.js';
import { browserToolDefs, executeBrowserTool } from '../../browser/tools.js';
import { walletToolDefs, executeWalletTool } from '../../browser/wallet.js';

export const agentControlTools: ToolDefinition[] = [
  {
    name: 'task_complete',
    description:
      'Signal that the user task has been completed successfully. Include a 1-2 sentence summary of what was verified. This ends the agent loop.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was completed and any evidence observed' },
        tx_hash: { type: 'string', description: 'On-chain tx hash if a transaction was submitted (optional)' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'task_failed',
    description:
      'Signal that the task cannot be completed. Include what was tried and why it failed. This ends the agent loop.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'What failed and what you observed' },
        terminal_state: {
          type: 'string',
          description:
            'Best guess at terminal state from the list: ready-to-action, needs-approval, wrong-network, unfunded, unconnected, min-amount, max-amount, unknown',
        },
      },
      required: ['reason'],
    },
  },
];

export function allToolDefs(): ToolDefinition[] {
  return [...browserToolDefs, ...walletToolDefs, ...agentControlTools];
}

export interface ToolCallOutcome extends ToolCallResult {
  toolName: string;
  /** Playwright-equivalent source line, if this action maps cleanly to Playwright code. */
  code?: string;
  terminal?: { kind: 'complete' | 'failed'; summary: string; txHash?: string; terminalState?: string };
}

export async function routeToolCall(
  name: string,
  input: Record<string, unknown>,
  ctx: BrowserCtx,
): Promise<ToolCallOutcome> {
  if (name === 'task_complete') {
    return {
      success: true,
      output: `Task complete: ${input.summary}`,
      toolName: name,
      terminal: {
        kind: 'complete',
        summary: String(input.summary ?? ''),
        txHash: input.tx_hash ? String(input.tx_hash) : undefined,
      },
    };
  }
  if (name === 'task_failed') {
    return {
      success: false,
      output: `Task failed: ${input.reason}`,
      toolName: name,
      terminal: {
        kind: 'failed',
        summary: String(input.reason ?? ''),
        terminalState: input.terminal_state ? String(input.terminal_state) : undefined,
      },
    };
  }

  if (name.startsWith('browser_')) {
    // Resolve ref BEFORE the call (refs get cleared on snapshot)
    const refInfo = typeof input.ref === 'string' ? ctx.snapshotRefs.get(input.ref) : undefined;
    const res = await executeBrowserTool(name, input, ctx);
    const code = res.success ? buildBrowserCode(name, input, refInfo) : undefined;
    return { ...res, toolName: name, code };
  }
  if (name.startsWith('wallet_')) {
    const res = await executeWalletTool(name, input, ctx);
    const code = res.success ? buildWalletCode(name, input) : undefined;
    return { ...res, toolName: name, code };
  }
  return { success: false, output: `Unknown tool: ${name}`, toolName: name };
}

// ---------- Playwright code-equivalent builders ----------

function buildBrowserCode(name: string, input: Record<string, unknown>, ref?: SnapshotRef): string | undefined {
  switch (name) {
    case 'browser_navigate':
      return `await page.goto(${JSON.stringify(input.url)}, { waitUntil: 'domcontentloaded' });`;

    case 'browser_snapshot':
      return undefined; // snapshots are implicit in Playwright; no code needed

    case 'browser_click': {
      const loc = refToLocator(ref);
      if (!loc) return `// click [ref=${input.ref}] — ref not resolvable`;
      return `await ${loc}.click();`;
    }

    case 'browser_type': {
      const loc = refToLocator(ref);
      const text = JSON.stringify(input.text ?? '');
      const clear = input.clear !== false;
      if (!loc) return `// type ${text} into [ref=${input.ref}] — ref not resolvable`;
      return clear ? `await ${loc}.fill(${text});` : `await ${loc}.type(${text});`;
    }

    case 'browser_screenshot':
      return `// screenshot: ${input.name}`;

    case 'browser_evaluate':
      return `await page.evaluate(${JSON.stringify(input.expression)});`;

    case 'browser_press_key':
      return `await page.keyboard.press(${JSON.stringify(input.key)});`;

    case 'browser_scroll': {
      const amount = (input.amount as number) || 500;
      const dir = input.direction === 'up' ? -amount : amount;
      return `await page.evaluate((y) => window.scrollBy(0, y), ${dir});`;
    }

    case 'browser_wait': {
      const t = (input.timeout as number) ?? 5000;
      if (input.text) return `await page.getByText(${JSON.stringify(input.text)}).first().waitFor({ timeout: ${t} });`;
      return `await page.waitForTimeout(${t});`;
    }
  }
  return undefined;
}

function buildWalletCode(name: string, input: Record<string, unknown>): string | undefined {
  switch (name) {
    case 'wallet_approve_connection': {
      const skip = input.skipSiwe ? ', { skipSiwe: true }' : '';
      return `await raceApprove(page${skip}); // wallet connect + SIWE`;
    }
    case 'wallet_sign':
      return `await raceSign(page);`;
    case 'wallet_confirm_transaction':
      return `await raceConfirmTransaction(page);`;
    case 'wallet_switch_network':
      return `await switchNetwork(page, ${JSON.stringify(input.networkName)});`;
    case 'wallet_reject':
      return `await raceReject(page);`;
    case 'wallet_get_address':
      return `const walletAddress = await getTestWalletAddress(page);`;
  }
  return undefined;
}

function refToLocator(ref?: SnapshotRef): string | undefined {
  if (!ref) return undefined;
  // Preference order: testId > role+name > text > tag
  if (ref.testId) {
    return `page.getByTestId(${JSON.stringify(ref.testId)})`;
  }
  if (ref.role && ref.name) {
    const name = ref.name.length > 60 ? ref.name.slice(0, 60) : ref.name;
    return `page.getByRole(${JSON.stringify(ref.role)}, { name: ${JSON.stringify(name)} }).first()`;
  }
  if (ref.name) {
    return `page.getByText(${JSON.stringify(ref.name.slice(0, 60))}).first()`;
  }
  if (ref.tag) {
    return `page.locator(${JSON.stringify(ref.tag)}).first()`;
  }
  return undefined;
}

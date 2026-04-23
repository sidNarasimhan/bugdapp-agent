/**
 * Routes tool calls from the agent loop to the correct executor.
 *
 * Reuses existing browser + wallet tool implementations:
 *   - src/browser/tools.ts       — browser_navigate, browser_snapshot, browser_click, ...
 *   - src/browser/wallet.ts      — wallet_approve_connection, wallet_sign, ...
 *
 * Adds a few agent-only tools:
 *   - task_complete  (signals terminal success)
 *   - task_failed    (signals terminal failure with explanation)
 */
import type { BrowserCtx, ToolDefinition, ToolCallResult } from '../../types.js';
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
    const res = await executeBrowserTool(name, input, ctx);
    return { ...res, toolName: name };
  }
  if (name.startsWith('wallet_')) {
    const res = await executeWalletTool(name, input, ctx);
    return { ...res, toolName: name };
  }
  return { success: false, output: `Unknown tool: ${name}`, toolName: name };
}

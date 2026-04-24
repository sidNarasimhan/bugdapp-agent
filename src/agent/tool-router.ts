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
import type { BrowserCtx, ToolDefinition, ToolCallResult, SnapshotRef } from '../types.js';
import { browserToolDefs, executeBrowserTool } from '../core/browser-tools.js';
import { walletToolDefs, executeWalletTool } from '../core/wallet-tools.js';
import { fetchAndDecodeReceipt } from '../chain/receipt.js';
import { activeDApp } from '../config.js';
import { resolveModuleContext, listModules } from './knowledge.js';

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
  {
    name: 'get_module_context',
    description:
      'Load a specific dApp module\'s detailed knowledge (components, entry points, constraints, docs, observed rules). Call this BEFORE operating on a module you haven\'t interacted with yet in this session. Provide at least one of: page_url (e.g. "/trade"), module_name (e.g. "Zero-Fee Perps"), or slug (e.g. "trade.zfp"). Returns ~1-3KB of markdown.',
    input_schema: {
      type: 'object',
      properties: {
        page_url: { type: 'string', description: 'URL or path hint — e.g. "/trade" or the full URL' },
        module_name: { type: 'string', description: 'Human name — e.g. "Zero-Fee Perps"' },
        slug: { type: 'string', description: 'Slug from the overview — e.g. "trade.zfp"' },
      },
    },
  },
  {
    name: 'wallet_verify_tx',
    description:
      'Fetch and decode a transaction receipt on-chain via viem. Call this AFTER wallet_confirm_transaction (and after the UI shows the tx was accepted) to prove the tx actually succeeded and observe its events. Required before task_complete when a transaction was submitted.',
    input_schema: {
      type: 'object',
      properties: {
        tx_hash: { type: 'string', description: 'The 0x-prefixed 66-char transaction hash' },
        chain_id: {
          type: 'number',
          description: 'EVM chain id. Defaults to the active dApp chain (e.g. 8453 for Base).',
        },
        timeout_ms: { type: 'number', description: 'Max polling time. Default 60000 (60s).' },
      },
      required: ['tx_hash'],
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

  if (name === 'get_module_context') {
    const hint = {
      page_url: typeof input.page_url === 'string' ? input.page_url : undefined,
      module_name: typeof input.module_name === 'string' ? input.module_name : undefined,
      slug: typeof input.slug === 'string' ? input.slug : undefined,
    };
    const hit = resolveModuleContext(hint, activeDApp());
    if (!hit) {
      const available = listModules().map(m => `${m.slug} (${m.name})`).join(', ');
      return {
        success: false,
        output: `No module matched hint ${JSON.stringify(hint)}. Available modules: ${available || '(none — modules.json missing)'}`,
        toolName: name,
      };
    }
    return {
      success: true,
      output: `# Module: ${hit.moduleName} (${hit.slug}, ${hit.bytes}B)\n\n${hit.content}`,
      toolName: name,
    };
  }

  if (name === 'wallet_verify_tx') {
    const txHash = String(input.tx_hash ?? '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return { success: false, output: `Invalid tx_hash (expected 0x + 64 hex chars). Got: ${txHash}`, toolName: name };
    }
    const chainId = typeof input.chain_id === 'number' ? input.chain_id : activeDApp().chain.id;
    const timeoutMs = typeof input.timeout_ms === 'number' ? input.timeout_ms : 60_000;
    try {
      const receipt = await fetchAndDecodeReceipt(chainId, txHash as `0x${string}`, { timeoutMs });
      const events = receipt.events.map(e => ({
        name: e.name,
        address: e.address,
        args: e.args,
      }));
      const summary = {
        status: receipt.status,
        blockNumber: String(receipt.blockNumber),
        gasUsed: String(receipt.gasUsed),
        from: receipt.from,
        to: receipt.to,
        eventCount: events.length,
        events: events.slice(0, 20),
        rawLogCount: receipt.rawLogs.length,
      };
      return {
        success: receipt.status === 'success',
        output: JSON.stringify(summary, null, 2),
        toolName: name,
        code: `// verify tx ${txHash} on chain ${chainId} — status=${receipt.status}`,
      };
    } catch (e: any) {
      return {
        success: false,
        output: `wallet_verify_tx failed: ${e?.message ?? e}`,
        toolName: name,
      };
    }
  }

  if (name.startsWith('browser_')) {
    // Resolve ref BEFORE the call (refs get cleared on snapshot)
    const refInfo = typeof input.ref === 'string' ? ctx.snapshotRefs.get(input.ref) : undefined;
    const res = await executeBrowserTool(name, input, ctx);
    const code = res.success ? buildBrowserCode(name, input, refInfo) : undefined;

    // Auto-inject module context after a successful navigate — RAG retrieval
    // without a separate tool call. The agent sees the new module's .md in the
    // next observation alongside "Navigated to …" output.
    let output = res.output;
    if (name === 'browser_navigate' && res.success) {
      const urlHint = typeof input.url === 'string' ? input.url : undefined;
      if (urlHint) {
        const hit = resolveModuleContext({ page_url: urlHint }, activeDApp());
        if (hit) {
          output = `${res.output}\n\n[RAG auto-injected module: ${hit.moduleName} (${hit.slug})]\n\n${hit.content}`;
        }
      }
    }
    return { ...res, output, toolName: name, code };
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

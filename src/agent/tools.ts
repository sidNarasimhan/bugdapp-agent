import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { BrowserCtx } from '../types.js';
import { executeBrowserTool } from '../browser/tools.js';
import { executeWalletTool } from '../browser/wallet.js';

/**
 * Creates all browser + wallet tools bound to a shared BrowserCtx.
 * The ctx is passed via closure so all tools share the same page/context.
 */
export function createBrowserTools(ctx: BrowserCtx): DynamicStructuredTool[] {
  return [
    new DynamicStructuredTool({
      name: 'browser_navigate',
      description: 'Navigate to a URL',
      schema: z.object({ url: z.string().describe('URL to navigate to') }),
      func: async ({ url }) => {
        const r = await executeBrowserTool('browser_navigate', { url }, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'browser_snapshot',
      description: 'Get accessibility snapshot of the page. Returns elements with [ref=eN] identifiers for clicking/typing.',
      schema: z.object({}),
      func: async () => {
        const r = await executeBrowserTool('browser_snapshot', {}, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'browser_click',
      description: 'Click an element by its ref from a snapshot (e.g. "e5")',
      schema: z.object({
        ref: z.string().describe('Element ref from snapshot'),
        description: z.string().optional().describe('What you are clicking and why'),
      }),
      func: async ({ ref, description }) => {
        const r = await executeBrowserTool('browser_click', { ref, description }, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'browser_type',
      description: 'Type text into an input element by ref',
      schema: z.object({
        ref: z.string().describe('Element ref'),
        text: z.string().describe('Text to type'),
        clear: z.boolean().optional().describe('Clear field first (default: true)'),
      }),
      func: async ({ ref, text, clear }) => {
        const r = await executeBrowserTool('browser_type', { ref, text, clear }, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current page',
      schema: z.object({ name: z.string().describe('Screenshot file name') }),
      func: async ({ name }) => {
        const r = await executeBrowserTool('browser_screenshot', { name }, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'browser_evaluate',
      description: 'Execute JavaScript in the page and return result',
      schema: z.object({ expression: z.string().describe('JavaScript to evaluate') }),
      func: async ({ expression }) => {
        const r = await executeBrowserTool('browser_evaluate', { expression }, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'browser_press_key',
      description: 'Press a keyboard key (e.g. "Enter", "Escape", "Tab")',
      schema: z.object({ key: z.string().describe('Key to press') }),
      func: async ({ key }) => {
        const r = await executeBrowserTool('browser_press_key', { key }, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'browser_scroll',
      description: 'Scroll the page up or down',
      schema: z.object({
        direction: z.enum(['up', 'down']).describe('Scroll direction'),
        amount: z.number().optional().describe('Pixels to scroll (default: 500)'),
      }),
      func: async ({ direction, amount }) => {
        const r = await executeBrowserTool('browser_scroll', { direction, amount }, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'browser_wait',
      description: 'Wait for text to appear or for a timeout',
      schema: z.object({
        text: z.string().optional().describe('Text to wait for'),
        timeout: z.number().optional().describe('Max wait in ms (default: 10000)'),
      }),
      func: async ({ text, timeout }) => {
        const r = await executeBrowserTool('browser_wait', { text, timeout }, ctx);
        return r.output;
      },
    }),
  ];
}

export function createWalletTools(ctx: BrowserCtx): DynamicStructuredTool[] {
  return [
    new DynamicStructuredTool({
      name: 'wallet_approve_connection',
      description: 'Approve MetaMask connection + auto-handle SIWE. Call AFTER clicking the dApp\'s Connect/Login button.',
      schema: z.object({
        skipSiwe: z.boolean().optional().describe('Skip SIWE handling (default: false)'),
      }),
      func: async ({ skipSiwe }) => {
        const r = await executeWalletTool('wallet_approve_connection', { skipSiwe }, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'wallet_sign',
      description: 'Approve a MetaMask signature request',
      schema: z.object({}),
      func: async () => {
        const r = await executeWalletTool('wallet_sign', {}, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'wallet_confirm_transaction',
      description: 'Confirm an on-chain transaction in MetaMask',
      schema: z.object({}),
      func: async () => {
        const r = await executeWalletTool('wallet_confirm_transaction', {}, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'wallet_switch_network',
      description: 'Switch MetaMask to a network. Supported: Base, Arbitrum One, OP Mainnet, Polygon, Ethereum Mainnet.',
      schema: z.object({
        networkName: z.string().describe('Network name (e.g. "Base")'),
      }),
      func: async ({ networkName }) => {
        const r = await executeWalletTool('wallet_switch_network', { networkName }, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'wallet_reject',
      description: 'Reject any pending MetaMask request',
      schema: z.object({}),
      func: async () => {
        const r = await executeWalletTool('wallet_reject', {}, ctx);
        return r.output;
      },
    }),

    new DynamicStructuredTool({
      name: 'wallet_get_address',
      description: 'Get the currently connected wallet address',
      schema: z.object({}),
      func: async () => {
        const r = await executeWalletTool('wallet_get_address', {}, ctx);
        return r.output;
      },
    }),
  ];
}

export function createAllTools(ctx: BrowserCtx): DynamicStructuredTool[] {
  return [...createBrowserTools(ctx), ...createWalletTools(ctx)];
}

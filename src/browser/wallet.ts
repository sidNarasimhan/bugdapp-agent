import type { BrowserContext, Page } from 'playwright-core';
import type { BrowserCtx, ToolDefinition, ToolCallResult } from '../types.js';

// ── Tool Definitions ──

export const walletToolDefs: ToolDefinition[] = [
  {
    name: 'wallet_approve_connection',
    description: 'Approve a MetaMask wallet connection request and auto-handle SIWE (Sign-In with Ethereum) popup. Call this AFTER clicking the dApp\'s "Connect Wallet" button.',
    input_schema: {
      type: 'object',
      properties: { skipSiwe: { type: 'boolean', description: 'Skip SIWE handling (default: false)' } },
    },
  },
  {
    name: 'wallet_sign',
    description: 'Approve a MetaMask signature request. Call AFTER the dApp triggers a personal_sign or signTypedData request.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'wallet_confirm_transaction',
    description: 'Confirm an on-chain transaction in MetaMask. Call AFTER the dApp submits a transaction.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'wallet_switch_network',
    description: 'Switch MetaMask to a different network. Supported: Base, Arbitrum One, OP Mainnet, Polygon, Ethereum Mainnet.',
    input_schema: {
      type: 'object',
      properties: { networkName: { type: 'string', description: 'Network name' } },
      required: ['networkName'],
    },
  },
  {
    name: 'wallet_reject',
    description: 'Reject any pending MetaMask request.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'wallet_get_address',
    description: 'Get the currently connected wallet address from the dApp page.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ── Helpers ──

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function getExtensionId(ctx: BrowserCtx): string | null {
  if (ctx.extensionId) return ctx.extensionId;
  for (const p of ctx.context.pages()) {
    try {
      if (p.url().startsWith('chrome-extension://')) return new URL(p.url()).hostname;
    } catch {}
  }
  for (const sw of ctx.context.serviceWorkers()) {
    try {
      if (sw.url().startsWith('chrome-extension://')) return new URL(sw.url()).hostname;
    } catch {}
  }
  return null;
}

async function clickBtn(page: Page, name: string, timeout = 2000): Promise<boolean> {
  try {
    const btn = page.getByRole('button', { name: new RegExp(name, 'i') });
    if (await btn.first().isVisible({ timeout }).catch(() => false)) {
      await btn.first().click();
      return true;
    }
  } catch {}
  return false;
}

/**
 * Open notification.html and handle the pending request using getByRole
 * (which pierces MetaMask's Shadow DOM).
 */
async function handleNotification(
  ctx: BrowserCtx,
  mode: 'connect' | 'sign' | 'confirm' | 'reject' | 'approve',
): Promise<boolean> {
  const extId = getExtensionId(ctx);
  if (!extId) return false;

  const notif = await ctx.context.newPage();
  await notif.goto(`chrome-extension://${extId}/notification.html`);
  await notif.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(2000);

  // Scroll if needed
  await clickBtn(notif, 'Scroll down', 1000);

  const buttonSets: Record<string, string[]> = {
    connect: ['Connect', 'Next', 'Confirm'],
    sign: ['Sign', 'Confirm', 'Approve'],
    confirm: ['Confirm', 'Approve'],
    reject: ['Reject', 'Cancel'],
    approve: ['Approve', 'Confirm', 'Switch network', 'Add network'],
  };

  let clicked = false;
  for (const label of buttonSets[mode]) {
    if (await clickBtn(notif, label)) {
      clicked = true;
      await sleep(2000);
      // Connect has a second screen (permissions)
      if (mode === 'connect' && !notif.isClosed()) {
        for (const l2 of ['Connect', 'Confirm']) {
          if (await clickBtn(notif, l2)) break;
        }
      }
      break;
    }
  }

  if (!notif.isClosed()) {
    await notif.waitForEvent('close', { timeout: 10000 }).catch(() => {});
  }
  if (!notif.isClosed()) await notif.close().catch(() => {});
  return clicked;
}

// ── Tool Executor ──

export async function executeWalletTool(
  name: string,
  input: Record<string, unknown>,
  ctx: BrowserCtx,
): Promise<ToolCallResult> {
  try {
    switch (name) {
      case 'wallet_approve_connection': {
        await sleep(2000);
        await handleNotification(ctx, 'connect');
        await sleep(2000);
        await ctx.page.bringToFront();

        // Handle SIWE
        if (!input.skipSiwe) {
          // Wait for SIWE request to arrive at MetaMask
          await sleep(5000);
          await handleNotification(ctx, 'sign');
          await sleep(2000);
          await ctx.page.bringToFront();
        }
        return ok('Wallet connection approved' + (input.skipSiwe ? '' : ' and SIWE signed'));
      }

      case 'wallet_sign': {
        await sleep(1000);
        await handleNotification(ctx, 'sign');
        await sleep(500);
        await ctx.page.bringToFront();
        return ok('Signature approved');
      }

      case 'wallet_confirm_transaction': {
        await sleep(1000);
        await handleNotification(ctx, 'confirm');
        await sleep(500);
        await ctx.page.bringToFront();
        return ok('Transaction confirmed');
      }

      case 'wallet_switch_network': {
        const networkName = input.networkName as string;
        if (!networkName) return fail('networkName is required');

        // Use wallet_addEthereumChain to add + switch (works even if network exists)
        const chainConfigs: Record<string, { chainId: string; rpc: string; explorer: string }> = {
          'base': { chainId: '0x2105', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org' },
          'arbitrum': { chainId: '0xa4b1', rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io' },
          'arbitrum one': { chainId: '0xa4b1', rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io' },
          'optimism': { chainId: '0xa', rpc: 'https://mainnet.optimism.io', explorer: 'https://optimistic.etherscan.io' },
          'op mainnet': { chainId: '0xa', rpc: 'https://mainnet.optimism.io', explorer: 'https://optimistic.etherscan.io' },
          'polygon': { chainId: '0x89', rpc: 'https://polygon-rpc.com', explorer: 'https://polygonscan.com' },
        };
        const config = chainConfigs[networkName.toLowerCase()];

        if (config) {
          // Fire the add chain request (blocks until user approves)
          const addPromise = ctx.page.evaluate(async (params) => {
            try {
              await (window as any).ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                  chainId: params.chainId,
                  chainName: params.name,
                  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                  rpcUrls: [params.rpc],
                  blockExplorerUrls: [params.explorer],
                }],
              });
              return 'ok';
            } catch (e: any) { return e.message; }
          }, { chainId: config.chainId, name: networkName, rpc: config.rpc, explorer: config.explorer });

          // Approve the popup
          await sleep(3000);
          await handleNotification(ctx, 'approve');
          await sleep(2000);
          await handleNotification(ctx, 'approve'); // possible second screen

          await Promise.race([addPromise, sleep(15000)]);
        } else {
          // For Ethereum mainnet, just switch
          await ctx.page.evaluate(async () => {
            await (window as any).ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: '0x1' }],
            });
          }).catch(() => {});
        }

        await sleep(1000);
        const chainId = await ctx.page.evaluate(() =>
          (window as any).ethereum?.request?.({ method: 'eth_chainId' })
        ).catch(() => null);
        return ok(`Switched to ${networkName}${chainId ? ` (chainId: ${chainId})` : ''}`);
      }

      case 'wallet_reject': {
        await handleNotification(ctx, 'reject');
        return ok('Request rejected');
      }

      case 'wallet_get_address': {
        const addr = await ctx.page.evaluate(() => {
          const eth = (window as any).ethereum;
          return eth?.selectedAddress || eth?.accounts?.[0] || null;
        }).catch(() => null);
        if (addr) return ok(`Connected wallet: ${addr}`);
        return ok('Wallet not connected');
      }

      default:
        return fail(`Unknown wallet tool: ${name}`);
    }
  } catch (e) {
    return fail(`${name} error: ${(e as Error).message}`);
  }
}

function ok(output: string): ToolCallResult { return { success: true, output }; }
function fail(output: string): ToolCallResult { return { success: false, output }; }

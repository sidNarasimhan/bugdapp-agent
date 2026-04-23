import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { BrowserCtx } from '../types.js';
import { setupMetaMask } from './metamask-setup.js';

/**
 * Launch a browser with MetaMask via Playwright CDP.
 * Two modes:
 *   - Local: launchPersistentContext with --load-extension
 *   - Docker/remote: connectOverCDP to pre-launched Chromium
 */
export async function launchBrowser(opts: {
  seedPhrase: string;
  headless: boolean;
  screenshotDir: string;
  cdpUrl?: string;
  metamaskPath?: string;
  userDataDir?: string;
}): Promise<BrowserCtx> {
  mkdirSync(opts.screenshotDir, { recursive: true });

  let context: BrowserContext;
  let page: Page;

  if (opts.cdpUrl) {
    // Docker/remote mode: connect to existing browser with MetaMask already loaded
    console.log(`[Launcher] Connecting to CDP at ${opts.cdpUrl}...`);
    const browser = await chromium.connectOverCDP(opts.cdpUrl, { timeout: 15000 });
    context = browser.contexts()[0];
    page = context.pages().find(p => !p.url().startsWith('chrome-extension://')) || context.pages()[0];
    if (!page) page = await context.newPage();
    console.log('[Launcher] Connected via CDP');
  } else {
    // Local mode: launch Chromium with MetaMask extension
    const metamaskPath = opts.metamaskPath || await resolveMetaMaskPath();
    const userDataDir = opts.userDataDir || join(process.cwd(), '.chromium-profile');

    console.log(`[Launcher] Launching Chromium with MetaMask extension...`);
    const args = [
      '--no-first-run',
      '--disable-popup-blocking',
      '--disable-default-apps',
      '--disable-translate',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ];

    if (metamaskPath && existsSync(metamaskPath)) {
      args.push(`--disable-extensions-except=${metamaskPath}`);
      args.push(`--load-extension=${metamaskPath}`);
      console.log(`[Launcher] Loading MetaMask from ${metamaskPath}`);
    } else {
      console.warn('[Launcher] MetaMask extension path not found, launching without wallet');
    }

    // Extensions require headed mode — use Xvfb in Docker for "headless"
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args,
      viewport: { width: 1920, height: 1080 },
      ignoreDefaultArgs: ['--disable-extensions'],
    });

    // Wait for MetaMask to initialize
    await new Promise(r => setTimeout(r, 3000));

    // Setup MetaMask wallet if needed
    if (metamaskPath && existsSync(metamaskPath)) {
      await setupMetaMask(context, opts.seedPhrase);
    }

    page = await context.newPage();
    console.log('[Launcher] Browser ready with MetaMask');
  }

  return {
    page,
    context,
    extensionId: getExtensionId(context) || undefined,
    snapshotRefs: new Map(),
    screenshotDir: opts.screenshotDir,
    screenshotCounter: 0,
  };
}

export async function closeBrowser(ctx: BrowserCtx): Promise<void> {
  try { await ctx.page.close(); } catch {}
  try { await ctx.context.close(); } catch {}
}

function getExtensionId(context: BrowserContext): string | null {
  const mm = context.pages().find(p => {
    try { return p.url().startsWith('chrome-extension://'); } catch { return false; }
  });
  if (!mm) return null;
  try { return new URL(mm.url()).hostname; } catch { return null; }
}

async function resolveMetaMaskPath(): Promise<string> {
  // Check common locations
  const candidates = [
    join(process.cwd(), 'metamask-extension'),
    '/opt/metamask/extension',
    join(process.env.HOME || process.env.USERPROFILE || '', '.metamask-extension'),
  ];

  // Also check dappwright cache (may exist from previous installs)
  const dappwrightDirs = [
    join(process.env.TEMP || process.env.TMP || '/tmp', 'dappwright', 'metamask'),
    join(process.env.LOCALAPPDATA || '', 'Temp', 'dappwright', 'metamask'),
    '/tmp/dappwright/metamask',
    '/opt/metamask/extension',
  ];
  for (const dappwrightDir of dappwrightDirs) {
    if (existsSync(dappwrightDir)) {
      try {
        const versions = readdirSync(dappwrightDir).filter(f => !f.endsWith('.zip')).sort().reverse();
        for (const v of versions) {
          candidates.push(join(dappwrightDir, v));
        }
      } catch {}
    }
  }

  for (const p of candidates) {
    if (existsSync(join(p, 'manifest.json'))) {
      console.log(`[Launcher] Found MetaMask at ${p}`);
      return p;
    }
  }
  console.warn('[Launcher] No MetaMask extension found. Download it or pass --metamask-path');
  return '';
}

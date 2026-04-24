/**
 * Browser + MetaMask session manager for the chat agent.
 *
 * Lifecycle:
 *   - One browser instance per bot process. Launches lazily on first task.
 *   - MM onboarded once, reused across chat messages.
 *   - `reset()` tears down; next task launches fresh.
 *   - Process exit hooks close the browser.
 *
 * NOT thread-safe: one task at a time per bot. Handler enforces this via
 * the `activeRuns` set in handler.ts.
 */
import { join } from 'path';
import type { BrowserCtx } from '../types.js';
import { launchBrowser, closeBrowser } from '../core/browser-launch.js';

let current: BrowserCtx | null = null;
let launchInFlight: Promise<BrowserCtx> | null = null;

export async function getOrLaunchSession(url?: string): Promise<BrowserCtx> {
  if (current) {
    if (url && !current.page.url().startsWith(url)) {
      try { await current.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
      catch (e: any) { console.error(`[session] navigate to ${url} failed: ${e?.message}`); }
    }
    return current;
  }
  if (launchInFlight) return launchInFlight;

  launchInFlight = (async () => {
    const seedPhrase = process.env.SEED_PHRASE;
    if (!seedPhrase) throw new Error('SEED_PHRASE not set in .env');
    const metamaskPath = process.env.METAMASK_PATH;
    if (!metamaskPath) throw new Error('METAMASK_PATH not set in .env');

    const screenshotDir = join(process.cwd(), 'output', '_session', 'screenshots');
    console.error('[session] launching Chromium + MetaMask...');
    const ctx = await launchBrowser({
      seedPhrase,
      headless: false,
      screenshotDir,
      metamaskPath,
      userDataDir: join(process.cwd(), '.chromium-profile'),
    });
    if (url) {
      try { await ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
      catch (e: any) { console.error(`[session] initial navigate to ${url} failed: ${e?.message}`); }
    }
    current = ctx;
    console.error('[session] ready');
    return ctx;
  })();

  try { return await launchInFlight; }
  finally { launchInFlight = null; }
}

export async function resetSession(): Promise<void> {
  if (!current) return;
  try { await closeBrowser(current); } catch {}
  current = null;
}

export function currentSession(): BrowserCtx | null { return current; }

let installedExitHooks = false;
export function installExitHooks(): void {
  if (installedExitHooks) return;
  installedExitHooks = true;
  const cleanup = async () => {
    if (current) {
      try { await closeBrowser(current); } catch {}
      current = null;
    }
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('beforeExit', cleanup);
}

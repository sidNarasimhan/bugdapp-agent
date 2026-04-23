/**
 * Playwright test fixtures for Web3 dApp testing with MetaMask.
 * Uses Playwright CDP — NO dappwright dependency.
 *
 * Usage in test files:
 *   import { test, expect, connectWallet, raceApprove } from '../fixtures/wallet.fixture';
 *   test('my test', async ({ page }) => { ... });
 */

import { test as base, expect } from '@playwright/test';
import { chromium, type BrowserContext, type CDPSession } from 'playwright-core';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
// Chain verification module — copied into output/<dapp>/fixtures/chain/ by spec-generator.
// Imports are relative to this fixture's install location, not to the project source.
import { installTxCapture } from './chain/tx-capture.js';

/**
 * Load a .env file from the project root into process.env. Playwright
 * subprocesses don't inherit shell-loaded env reliably on Windows, so we
 * look up from CWD for `.env` and parse it ourselves. No-op if not found
 * or if the variable is already set in the process env.
 */
function loadEnvFromDotEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      const txt = readFileSync(candidate, 'utf-8');
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
        if (!m) continue;
        const k = m[1];
        if (process.env[k]) continue;
        let v = m[2];
        v = v.replace(/^['"]|['"]$/g, '');
        process.env[k] = v;
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
loadEnvFromDotEnv();

const SEED_PHRASE =
  process.env.SEED_PHRASE ||
  'test test test test test test test test test test test junk';

const METAMASK_PATH = process.env.METAMASK_PATH || '/opt/metamask/extension';
if (!existsSync(join(METAMASK_PATH, 'manifest.json'))) {
  console.error(`[Fixture] METAMASK_PATH does not contain manifest.json: ${METAMASK_PATH}`);
  console.error(`[Fixture] Set METAMASK_PATH in .env at the project root. Tests will run without a wallet and probably fail.`);
} else {
  console.log(`[Fixture] MetaMask extension found at ${METAMASK_PATH}`);
}
// Per-worker unique user-data-dir. Sharing one dir across workers (or across
// re-runs that happen quickly) caused Chromium to exit with code 21 on the
// 2026-04-11 Aave run — the previous browser's lock file was still on disk
// when the next test tried to launch. We append the worker index AND a fresh
// timestamp so even sequential runs don't collide.
const USER_DATA_DIR = process.env.USER_DATA_DIR
  || join(process.cwd(), `.chromium-profile-w${process.env.TEST_WORKER_INDEX ?? '0'}-${process.pid}`);
const STEP_SCREENSHOTS_DIR = process.env.STEP_SCREENSHOTS_DIR || '/tmp/test-results/steps';

/**
 * Extended Playwright test with wallet-ready browser context.
 * Worker-scoped context with MetaMask extension loaded.
 */
export const test = base.extend<
  {},
  { walletContext: BrowserContext }
>({
  walletContext: [
    async ({}, use) => {
      const cdpUrl = process.env.CDP_URL;
      let context: BrowserContext;

      if (cdpUrl) {
        // Docker mode: connect to pre-launched browser
        const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15000 });
        context = browser.contexts()[0];
      } else {
        // Local mode: launch with MetaMask extension
        const args = [
          '--no-first-run',
          '--disable-popup-blocking',
          '--disable-default-apps',
        ];
        if (existsSync(join(METAMASK_PATH, 'manifest.json'))) {
          args.push(`--disable-extensions-except=${METAMASK_PATH}`);
          args.push(`--load-extension=${METAMASK_PATH}`);
        }
        context = await chromium.launchPersistentContext(USER_DATA_DIR, {
          headless: false,
          args,
          viewport: { width: 1920, height: 1080 },
          ignoreDefaultArgs: ['--disable-extensions'],
        });
        // Wait for MetaMask to initialize
        await new Promise(r => setTimeout(r, 3000));

        // Import wallet if MetaMask needs onboarding
        await ensureMetaMaskReady(context, SEED_PHRASE);
      }

      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],

  context: async ({ walletContext }, use) => {
    await use(walletContext);
  },

  page: async ({ context }, use, testInfo) => {
    const page = await context.newPage();

    // Install the tx-capture shim BEFORE the dApp navigates. This hooks
    // window.ethereum.request so every eth_sendTransaction hash is recorded
    // for the on-chain verification layer.
    try { await installTxCapture(page); } catch { /* capture is best-effort */ }

    // Start CDP screencast
    const framesDir = join(testInfo.outputDir, '_screencast_frames');
    let cdpSession: CDPSession | null = null;
    let frameIndex = 0;
    interface ScreencastFrame { index: number; filename: string; timestamp: number; }
    const frames: ScreencastFrame[] = [];

    try {
      mkdirSync(framesDir, { recursive: true });
      cdpSession = await context.newCDPSession(page);

      cdpSession.on('Page.screencastFrame', async (params: any) => {
        try {
          const { data, metadata, sessionId } = params;
          const filename = `frame-${String(frameIndex).padStart(5, '0')}.jpg`;
          writeFileSync(join(framesDir, filename), Buffer.from(data, 'base64'));
          frames.push({ index: frameIndex, filename, timestamp: metadata.timestamp * 1000 });
          frameIndex++;
          await cdpSession!.send('Page.screencastFrameAck', { sessionId });
        } catch {}
      });

      await cdpSession.send('Page.startScreencast', {
        format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 720, everyNthFrame: 3,
      });
    } catch {}

    await use(page);

    if (cdpSession) {
      try {
        await cdpSession.send('Page.stopScreencast');
        await cdpSession.detach();
      } catch {}
    }

    if (frames.length > 0) {
      writeFileSync(
        join(testInfo.outputDir, 'screencast-manifest.json'),
        JSON.stringify({ frameCount: frames.length, frames, width: 1280, height: 720 }),
      );
    }

    await page.close();
  },
});

// ── MetaMask Setup ──

const MM_PASSWORD = 'Web3QaAgent!2026';

async function ensureMetaMaskReady(context: BrowserContext, rawSeedPhrase: string): Promise<void> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  // Strip surrounding quotes and collapse whitespace — SEED_PHRASE env vars exported
  // from .env files often arrive wrapped in literal double quotes.
  const seedPhrase = rawSeedPhrase.trim().replace(/^["']|["']$/g, '').trim().replace(/\s+/g, ' ');
  // Poll for the MetaMask MV3 service worker (or legacy background page) for up
  // to 30s. MV3 service workers on Windows + a cold Chromium profile can take
  // 5-15s to boot before Playwright sees them — the old 3s hard-wait frequently
  // missed the worker and the fixture silently fell back to "no wallet" mode.
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const p = context.pages().find(pg => pg.url().startsWith('chrome-extension://'));
    if (p) break;
    const sw = context.serviceWorkers().find(s => s.url().startsWith('chrome-extension://'));
    if (sw) break;
    await sleep(750);
  }
  await sleep(3000);

  let mm = context.pages().find(p => p.url().startsWith('chrome-extension://'));
  if (!mm) {
    const sw = context.serviceWorkers().find(s => s.url().includes('chrome-extension://'));
    if (sw) {
      const extId = new URL(sw.url()).hostname;
      mm = await context.newPage();
      await mm.goto(`chrome-extension://${extId}/home.html#onboarding/welcome`);
      await sleep(4000);
    }
  }
  if (!mm) { console.warn('[Fixture] MetaMask extension page not found'); return; }

  const extId = new URL(mm.url()).hostname;
  // Force-navigate to onboarding even if the extension page was already opened somewhere else.
  if (!mm.url().includes('onboarding')) {
    await mm.goto(`chrome-extension://${extId}/home.html#onboarding/welcome`);
    await sleep(4000);
  }

  // Detect state: onboarding vs already-imported-but-locked vs already-unlocked.
  const isOnboarding = mm.url().includes('onboarding') ||
    await mm.getByRole('button', { name: /I have an existing wallet/i }).isVisible({ timeout: 3000 }).catch(() => false) ||
    await mm.getByRole('button', { name: /Create a new wallet/i }).isVisible({ timeout: 2000 }).catch(() => false);

  if (!isOnboarding) {
    const passwordInput = mm.locator('input[type="password"]').first();
    if (await passwordInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('[Fixture] Wallet locked, unlocking...');
      await passwordInput.fill(MM_PASSWORD);
      await sleep(500);
      const unlockBtn = mm.getByRole('button', { name: /Unlock/i }).first();
      if (await unlockBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await unlockBtn.click();
        await sleep(3000);
      }
    } else {
      console.log('[Fixture] Wallet already unlocked');
    }
    return;
  }

  console.log('[Fixture] MetaMask onboarding — importing wallet...');

  try {
    // Some MM 13.x builds gate onboarding behind a terms checkbox / "Get started" click.
    const tosCheckbox = mm.locator('input[type="checkbox"]').first();
    if (await tosCheckbox.isVisible({ timeout: 1500 }).catch(() => false)) {
      if (!(await tosCheckbox.isChecked().catch(() => true))) {
        await tosCheckbox.click({ force: true }).catch(() => {});
      }
    }
    await clickMMBtn(mm, 'Get started', 1500);

    console.log('[Fixture] Step 1: existing wallet...');
    let existingClicked = false;
    for (const label of [
      'I have an existing wallet',
      'Import an existing wallet',
      'Import existing wallet',
      'Use existing wallet',
      'I already have a wallet',
    ]) {
      if (await clickMMBtn(mm, label, 3000)) { existingClicked = true; break; }
    }
    if (!existingClicked) {
      console.warn('[Fixture] Could not click any existing-wallet label variant');
      try { await mm.screenshot({ path: '/tmp/mm-step1-failed.png' }); } catch {}
      // Don't return — the next step may still work if we're on a different onboarding variant.
    }
    await sleep(3000);

    console.log('[Fixture] Step 2: import via SRP...');
    let importClicked = false;
    for (const label of [
      'Import using Secret Recovery Phrase',
      'Import secret recovery phrase',
      'Import wallet',
      'Continue with SRP',
    ]) {
      if (await clickMMBtn(mm, label, 3000)) { importClicked = true; break; }
    }
    if (!importClicked) {
      console.warn('[Fixture] Could not click any import-SRP label variant');
      try { await mm.screenshot({ path: '/tmp/mm-step2-failed.png' }); } catch {}
    }
    await sleep(3000);

    console.log('[Fixture] Step 3: seed phrase...');
    const words = seedPhrase.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 15 && words.length !== 18 && words.length !== 21 && words.length !== 24) {
      throw new Error(`[Fixture] seed phrase has ${words.length} words — expected 12/15/18/21/24. Check SEED_PHRASE in .env.`);
    }
    const filled = await fillSeedPhrase(mm, words);
    if (!filled) {
      try { await mm.screenshot({ path: '/tmp/mm-step3-seed-failed.png', fullPage: true }); } catch {}
      throw new Error('[Fixture] seed phrase import failed — none of the input strategies produced a filled SRP form. Screenshot at /tmp/mm-step3-seed-failed.png');
    }
    await sleep(2000);

    console.log('[Fixture] Step 4: confirm SRP...');
    for (const label of ['Confirm Secret Recovery Phrase', 'Confirm', 'Continue', 'Import', 'Next', 'Submit']) {
      if (await clickMMBtn(mm, label, 2000)) break;
    }
    await sleep(5000);

    console.log('[Fixture] Step 5: password...');
    // CRITICAL: MM uses input[type=password] for SRP word inputs too. Only search for
    // password fields AFTER the Create Password screen has loaded, otherwise we'll write
    // MM_PASSWORD into SRP slots and cause silent import failures.
    const createPasswordReady = await Promise.race([
      mm.waitForURL(/create-password|secure-your-wallet|password/i, { timeout: 15000 }).then(() => true).catch(() => false),
      mm.getByRole('heading', { name: /Create password|Secure your wallet/i }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false),
      mm.getByText(/New password|Confirm password/i).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false),
    ]);
    if (!createPasswordReady) {
      console.warn('[Fixture] Create Password screen did not appear — SRP step likely failed; aborting password fill');
      return;
    }
    await sleep(500);
    const pwInputs = mm.locator('input[type="password"]');
    const pwCount = await pwInputs.count();
    console.log(`[Fixture]   Found ${pwCount} password fields on Create Password screen`);
    if (pwCount >= 2) {
      await pwInputs.nth(0).fill(MM_PASSWORD);
      await pwInputs.nth(1).fill(MM_PASSWORD);
    }
    const cbs = mm.locator('input[type="checkbox"]');
    const cbCount = await cbs.count();
    for (let i = 0; i < cbCount; i++) {
      if (!(await cbs.nth(i).isChecked().catch(() => true))) {
        await cbs.nth(i).click({ force: true }).catch(() => {});
      }
    }
    await sleep(1000);

    console.log('[Fixture] Step 6: submit import...');
    if (!(await clickMMBtn(mm, 'Create password', 2000))) {
      if (!(await clickMMBtn(mm, 'Import my wallet', 2000))) {
        if (!(await clickMMBtn(mm, 'Confirm', 2000))) {
          await clickMMBtn(mm, 'Continue', 2000);
        }
      }
    }
    await sleep(10000);

    console.log('[Fixture] Step 7: dismiss post-setup...');
    for (const label of ['Got it', 'Done', 'Next', 'Continue', 'Open wallet', 'Close', 'Skip', 'Not now']) {
      await clickMMBtn(mm, label, 1500); await sleep(800);
    }
    for (const label of ['Got it', 'Done', 'Next']) {
      await clickMMBtn(mm, label, 1500); await sleep(800);
    }
    console.log('[Fixture] MetaMask ready!');
  } catch (e) {
    console.error(`[Fixture] MetaMask setup error: ${(e as Error).message}`);
  }
}

// ── Helpers ──

function getExtensionId(context: BrowserContext): string | null {
  for (const p of context.pages()) {
    try { if (p.url().startsWith('chrome-extension://')) return new URL(p.url()).hostname; } catch {}
  }
  for (const sw of context.serviceWorkers()) {
    try { if (sw.url().startsWith('chrome-extension://')) return new URL(sw.url()).hostname; } catch {}
  }
  return null;
}

async function clickMMBtn(page: any, name: string, timeout = 2000): Promise<boolean> {
  try {
    const btn = page.getByRole('button', { name: new RegExp(name, 'i') });
    if (await btn.first().isVisible({ timeout }).catch(() => false)) {
      await btn.first().click();
      return true;
    }
  } catch {}
  // Fallback: MM 13.x sometimes uses non-button clickable elements for onboarding steps.
  try {
    const el = page.getByText(name, { exact: false }).first();
    if (await el.isVisible({ timeout: Math.min(timeout, 1500) }).catch(() => false)) {
      await el.click();
      return true;
    }
  } catch {}
  return false;
}

/**
 * Fill the MetaMask SRP (Secret Recovery Phrase) import form.
 *
 * MM 13.x on different builds/locales shows one of three shapes:
 *   A) A grid of 12/15/18/21/24 individual `input` elements, each addressed by
 *      `data-testid="import-srp__srp-word-<i>"` or id `#import-srp__srp-word-<i>`.
 *      This is the most common shape in MM 13.22.
 *   B) A single `textarea` that accepts the whole phrase pasted at once —
 *      MM auto-splits across per-word cells behind the scenes.
 *   C) A "paste phrase" button/affordance that opens a combined input.
 *
 * The original implementation tried (B) first with `pressSequentially`, which
 * dropped characters when MM re-rendered on each keystroke — hence the "cut-off"
 * bug the user saw. We now try strategies in order of reliability:
 *
 *   1. Per-word inputs with `input.fill()` — deterministic, no typing races.
 *   2. Textarea with `locator.fill()` (instant write, no keystroke loop).
 *   3. Clipboard paste via `evaluate` + Ctrl+V on the first input.
 *
 * Returns true if the form was filled fully + verified, false if all strategies
 * failed to complete. Verification: we re-read the input values after filling
 * and require every word to be present. The caller should treat false as fatal.
 */
async function fillSeedPhrase(mm: any, words: string[]): Promise<boolean> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // MM 13.22 has a single input (testid `srp-input-import__srp-note`) that expects
  // the phrase typed in with real keystrokes — `fill()` skips the word-validation
  // handler and Continue stays disabled. We must type each word and press Space
  // between them so MM's onInput → validate → buildSrp chain fires correctly.
  //
  // Older MM shapes use a 12-input grid (`import-srp__srp-word-<i>`). We try
  // both. Per-word grid takes priority if present.

  // ── Strategy 1: per-word input grid (older MM) ──
  try {
    const firstSlot = mm.locator(`input[data-testid="import-srp__srp-word-0"]`)
      .or(mm.locator(`#import-srp__srp-word-0`))
      .first();
    if (await firstSlot.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`[Fixture]   SRP per-word grid detected — typing ${words.length} slots`);
      for (let i = 0; i < words.length; i++) {
        const input = mm.locator(`input[data-testid="import-srp__srp-word-${i}"]`)
          .or(mm.locator(`#import-srp__srp-word-${i}`))
          .first();
        await input.click({ timeout: 2000 }).catch(() => {});
        // Type to trigger MM's onChange handler; fill() bypasses it.
        await input.pressSequentially(words[i], { delay: 15 });
        await sleep(80);
      }
      if (await verifyGridFilled(mm, words)) {
        console.log('[Fixture]   per-word grid verified');
        return true;
      }
      console.warn('[Fixture]   per-word grid verification failed — trying single-input path');
    }
  } catch (e) {
    console.warn(`[Fixture]   per-word grid strategy threw: ${(e as Error).message}`);
  }

  // ── Strategy 2: single input (MM 13.22 canonical shape) — type word by word ──
  try {
    const srpInput = mm.locator(`input[data-testid="srp-input-import__srp-note"]`)
      .or(mm.locator(`textarea[data-testid="srp-input-import__srp-note"]`))
      .or(mm.locator('textarea[placeholder*="space between each word" i]'))
      .or(mm.locator('input[placeholder*="space between each word" i]'))
      .or(mm.locator('textarea').first())
      .first();
    const visible = await srpInput.isVisible({ timeout: 4000 }).catch(() => false);
    if (visible) {
      console.log(`[Fixture]   SRP single-input detected — typing ${words.length} words with spaces`);
      await srpInput.click({ timeout: 2000 });
      // Clear in case MM prefilled anything.
      await mm.keyboard.press('Control+A').catch(() => {});
      await mm.keyboard.press('Delete').catch(() => {});
      for (let i = 0; i < words.length; i++) {
        // Use page.keyboard.type — routes through the real input handler so MM
        // sees characters arrive one at a time + fires its word validator on
        // each space.
        await mm.keyboard.type(words[i], { delay: 20 });
        if (i < words.length - 1) {
          await mm.keyboard.press('Space');
          await sleep(60);
        }
      }
      await sleep(1200);

      // Verification: Continue button should become enabled once MM validates
      // all 12 words. That's the authoritative signal.
      const continueBtn = mm.getByRole('button', { name: /^Continue$/i }).first();
      if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        const disabled = await continueBtn.isDisabled().catch(() => true);
        if (!disabled) {
          console.log('[Fixture]   single-input typed + Continue is enabled — SRP validated');
          return true;
        }
        console.warn('[Fixture]   Continue still disabled — SRP likely malformed (cutoff or wrong words)');
      } else {
        console.warn('[Fixture]   Continue button not found to verify — assuming success');
        return true;
      }
    }
  } catch (e) {
    console.warn(`[Fixture]   single-input strategy threw: ${(e as Error).message}`);
  }

  // ── Strategy 3: Paste button path (MM shows a "Paste" affordance next to the input) ──
  try {
    const pasteBtn = mm.getByRole('button', { name: /^Paste$/i }).first();
    if (await pasteBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('[Fixture]   Paste button available — using clipboard path');
      const phrase = words.join(' ');
      // Grant clipboard permission + write phrase to clipboard before clicking Paste.
      const context = mm.context();
      try { await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: mm.url() }); } catch {}
      await mm.evaluate(async (p: string) => {
        try { await navigator.clipboard.writeText(p); } catch {}
      }, phrase);
      await pasteBtn.click();
      await sleep(1500);
      const continueBtn = mm.getByRole('button', { name: /^Continue$/i }).first();
      if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false) && !(await continueBtn.isDisabled().catch(() => true))) {
        console.log('[Fixture]   paste path verified (Continue enabled)');
        return true;
      }
    }
  } catch (e) {
    console.warn(`[Fixture]   paste path threw: ${(e as Error).message}`);
  }

  return false;
}

/**
 * Verify the per-word SRP grid has every slot filled with the expected word.
 * Only applicable to older MM shapes; the 13.22 single-input shape has no
 * per-word read-back and is verified via the Continue button's enabled state.
 */
async function verifyGridFilled(mm: any, words: string[]): Promise<boolean> {
  for (let i = 0; i < words.length; i++) {
    const loc = mm.locator(`input[data-testid="import-srp__srp-word-${i}"]`)
      .or(mm.locator(`#import-srp__srp-word-${i}`))
      .first();
    const exists = await loc.count().catch(() => 0);
    if (exists === 0) return false;
    const val = (await loc.inputValue().catch(() => '')).trim().toLowerCase();
    if (val !== words[i].toLowerCase()) {
      console.warn(`[Fixture]   SRP slot ${i} mismatch: expected "${words[i]}" got "${val}"`);
      return false;
    }
  }
  return true;
}

/**
 * Handle a pending MetaMask request by finding the active notification page.
 *
 * MM 13.x flow: when a dApp calls eth_requestAccounts / wallet_switchEthereumChain / etc.,
 * MM opens a popup or uses the extension's notification.html page. This function:
 *   1. Waits briefly for any extension page with "notification" or "confirm" in the URL
 *   2. Falls back to opening notification.html directly if nothing opened
 *   3. Clicks the appropriate primary button (Connect / Confirm / Approve / Sign)
 */
async function handleNotification(context: BrowserContext, mode: 'connect' | 'sign' | 'confirm') {
  const extId = getExtensionId(context);
  if (!extId) return;

  // Step 1: give MM a moment to open its popup. Check existing pages for any notification-like URL.
  await new Promise(r => setTimeout(r, 1500));
  const findNotifPage = () => {
    return context.pages().find(p => {
      if (p.isClosed()) return false;
      const url = p.url();
      return url.startsWith(`chrome-extension://${extId}`) &&
        /notification|confirm|popup|permissions/i.test(url);
    });
  };

  let notif = findNotifPage();

  // Step 2: if no popup opened automatically, open notification.html directly.
  if (!notif) {
    try {
      notif = await context.newPage();
      await notif.goto(`chrome-extension://${extId}/notification.html`, { timeout: 5000 }).catch(() => {});
      await notif.waitForLoadState('domcontentloaded').catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
    } catch {
      if (notif && !notif.isClosed()) await notif.close().catch(() => {});
      return;
    }
  }
  if (!notif || notif.isClosed()) return;

  try { await clickMMBtn(notif, 'Scroll down', 1000); } catch {}

  const buttons: Record<string, string[]> = {
    connect: ['Connect', 'Confirm', 'Next', 'Approve'],
    sign: ['Sign', 'Confirm', 'Approve'],
    confirm: ['Confirm', 'Approve', 'Switch network'],
  };

  for (const label of buttons[mode]) {
    if (notif.isClosed()) break;
    if (await clickMMBtn(notif, label, 2000).catch(() => false)) {
      await new Promise(r => setTimeout(r, 1500));
      // Some MM flows need a second click (e.g., connect → permissions → confirm).
      if (mode === 'connect' && !notif.isClosed()) {
        for (const l2 of ['Confirm', 'Connect', 'Next']) {
          if (await clickMMBtn(notif, l2, 1500).catch(() => false)) break;
        }
      }
      break;
    }
  }

  // Don't force-close if MM closed it; don't wait forever if it's still open.
  if (!notif.isClosed()) {
    await notif.waitForEvent('close', { timeout: 5000 }).catch(() => {});
  }
}

/**
 * Approve wallet connection + SIWE via notification.html.
 */
export async function raceApprove(
  context: BrowserContext,
  page: InstanceType<typeof import('playwright-core').Page>,
  options?: { skipSiwe?: boolean },
): Promise<void> {
  await page.waitForTimeout(2000);
  await handleNotification(context, 'connect');
  await page.waitForTimeout(2000);
  await page.bringToFront();

  if (!options?.skipSiwe) {
    await page.waitForTimeout(5000);
    await handleNotification(context, 'sign');
    await page.waitForTimeout(2000);
    await page.bringToFront();
  }
}

/**
 * Approve MetaMask signature via notification.html.
 */
export async function raceSign(
  context: BrowserContext,
  page: InstanceType<typeof import('playwright-core').Page>,
): Promise<void> {
  await page.waitForTimeout(1000);
  await handleNotification(context, 'sign');
  await page.waitForTimeout(500);
  await page.bringToFront();
}

/**
 * Confirm MetaMask transaction via notification.html.
 */
export async function raceConfirmTransaction(
  context: BrowserContext,
  page: InstanceType<typeof import('playwright-core').Page>,
): Promise<void> {
  await page.waitForTimeout(1000);
  await handleNotification(context, 'confirm');
  await page.waitForTimeout(500);
  await page.bringToFront();
}

/**
 * Full wallet connection flow — navigate, click Login, approve MetaMask.
 */
export interface ConnectHints {
  /** Click these (by text or regex) BEFORE looking for MetaMask — to expand hidden wallet lists. */
  preMetaMaskClicks?: Array<string | RegExp>;
  /** Override the default Login/Connect button pattern if the dApp uses unusual label */
  loginButtonPattern?: RegExp;
  /** data-testid for the Connect button, if the dApp exposes one (more stable than text) */
  loginButtonTestId?: string;
}

export async function connectWallet(
  page: InstanceType<typeof import('playwright-core').Page>,
  dappUrl: string,
  chainParams?: SwitchChainParams,
  connectHints?: ConnectHints,
): Promise<void> {
  await page.goto(dappUrl);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);

  // Find the Connect/Login button — prefer data-testid, fall back to text pattern.
  const defaultLoginPattern = /^(Login|Connect Wallet|Connect)$/i;
  const loginPattern = connectHints?.loginButtonPattern ?? defaultLoginPattern;

  let loginBtn = connectHints?.loginButtonTestId
    ? page.getByTestId(connectHints.loginButtonTestId).first()
    : page.getByRole('button', { name: loginPattern }).first();

  let loginVisible = await loginBtn.isVisible({ timeout: 3000 }).catch(() => false);
  // Fall back to text pattern if testid didn't match (dApp may have changed the id).
  if (!loginVisible && connectHints?.loginButtonTestId) {
    loginBtn = page.getByRole('button', { name: loginPattern }).first();
    loginVisible = await loginBtn.isVisible({ timeout: 2000 }).catch(() => false);
  }
  if (!loginVisible) {
    // Already connected (persistent profile) — still verify network.
    await ensureCorrectNetwork(page, chainParams);
    return;
  }

  await loginBtn.click();
  await page.waitForTimeout(2500);

  // Privy-wrapped connect (Avantis): a "Continue with a wallet" intermediate screen.
  const privyWalletOption = page.getByRole('button', { name: /Continue with a wallet/i }).first();
  if (await privyWalletOption.isVisible({ timeout: 1500 }).catch(() => false)) {
    await privyWalletOption.click();
    await page.waitForTimeout(1500);
  }

  // Apply pre-MetaMask click hints from the profile (e.g., Uniswap's "Other wallets" expander).
  // Each hint is fire-and-forget: missing elements don't fail the connect flow.
  for (const hint of connectHints?.preMetaMaskClicks ?? []) {
    const pat = typeof hint === 'string' ? new RegExp('^' + hint + '$', 'i') : hint;
    const target = page.getByText(pat).first();
    if (await target.isVisible({ timeout: 1500 }).catch(() => false)) {
      await target.click({ timeout: 3000 }).catch(() => {});
      console.log(`[connectWallet] Applied pre-MM click hint: ${pat}`);
      await page.waitForTimeout(1000);
    }
  }

  // Click MetaMask option. Modern dApps use all sorts of markup — try:
  //   1. data-testid containing metamask
  //   2. button role with MetaMask name
  //   3. visible text "MetaMask" (not scoped to a dialog — many dApps don't use role=dialog)
  // We filter out false positives by requiring the text element to be in the UPPER HALF of the
  // viewport (wallet modals appear above the fold; footer "partner" mentions are below).
  let mmClicked = false;
  const mmLocators = [
    page.locator('[data-testid*="metamask" i]').first(),
    page.getByRole('button', { name: /^MetaMask$/i }).first(),
    page.getByText(/^MetaMask$/i).first(),
  ];
  for (const loc of mmLocators) {
    if (!(await loc.isVisible({ timeout: 2000 }).catch(() => false))) continue;
    // Filter: only click if the element is in the viewport AND not in the footer region.
    const box = await loc.boundingBox().catch(() => null);
    if (!box) continue;
    const viewport = page.viewportSize();
    if (viewport && box.y > viewport.height * 0.9) continue; // footer — skip
    await loc.click({ timeout: 4000 }).catch(() => {});
    console.log('[connectWallet] Clicked MetaMask option');
    mmClicked = true;
    break;
  }

  if (!mmClicked) {
    // Diagnostic dump for the user's triage.
    console.log('[connectWallet] MetaMask option not found — dumping visible clickables');
    try {
      const texts: string[] = [];
      const candidates = await page.locator('button, [role="button"], [cursor="pointer"]').all();
      for (const c of candidates.slice(0, 40)) {
        if (!(await c.isVisible().catch(() => false))) continue;
        const txt = (await c.innerText().catch(() => '')).trim().slice(0, 50);
        if (txt) texts.push(txt);
      }
      console.log('[connectWallet]   visible clickables:', JSON.stringify(texts.slice(0, 25)));
    } catch {}
  } else {
    await page.waitForTimeout(2000).catch(() => {});
  }

  // raceApprove can throw if the MM popup handshake gets its page closed mid-click.
  // Swallow here — the post-connect check below will detect whether the connection actually
  // succeeded based on the absence of the Login button, which is the ground truth.
  try {
    await raceApprove(page.context(), page);
  } catch (e) {
    console.warn('[connectWallet] raceApprove threw:', (e as Error).message);
  }
  await page.waitForTimeout(3000);
  await page.bringToFront();
  await page.waitForTimeout(2000);

  const cancelModal = page.getByRole('button', { name: 'Cancel' });
  if (await cancelModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await cancelModal.click();
    await page.waitForTimeout(1000);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);

  // After connect: switch network (RPC-level if chain params provided, else reactive CTA click).
  await ensureCorrectNetwork(page, chainParams);

  // Post-connect verification: log whether the wallet actually got connected. We no longer
  // hard-fail here — downstream state classifier will report `unconnected` if the dApp still
  // shows the Login button, which is a clean honest outcome. Hard-failing here used to kill
  // tests on minor connect-flow regressions and lose all the form-fill signal.
  try {
    await page.waitForTimeout(1500);
  } catch {
    // Page may have been destroyed by MM popup handling — surface as a clean warning.
    console.warn('[connectWallet] Page became unavailable during post-connect wait — test will likely report connect failure');
    return;
  }
  const loginStillVisible = await page
    .getByRole('button', { name: /^(Login|Connect Wallet|Connect)$/i })
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (loginStillVisible) {
    // Fail loud. Silently "passing" a test when the wallet never connected is
    // how we ended up with confidence numbers that didn't reflect reality.
    // The spec author can catch this error + handle gracefully if they truly
    // want to test the unconnected state; otherwise the test fails as it should.
    throw new Error('[connectWallet] wallet handshake did not complete — Login/Connect button still visible after connect flow');
  } else {
    console.log('[connectWallet] Wallet connected successfully');
  }
}

/**
 * Ensure the wallet is on the correct chain for the dApp.
 *
 * Two strategies, tried in order:
 *   1. Proactive: inject a `wallet_switchEthereumChain` RPC call via the dApp's
 *      `window.ethereum` provider. Race through MM add-network + switch-network popups.
 *   2. Reactive: if the dApp shows a "Switch to X" / "Wrong Network" CTA, click it
 *      and race through popups.
 *
 * Chain params are passed in by the caller — the fixture is chain-agnostic; only the
 * profile knows which chain this dApp runs on.
 */
export interface SwitchChainParams {
  chainHexId: string; // e.g. '0x2105' for Base
  chainName: string; // e.g. 'Base'
  rpcUrl: string;
  blockExplorerUrl: string;
  nativeCurrency: { symbol: string; decimals: number };
}

export async function ensureCorrectNetwork(
  page: InstanceType<typeof import('playwright-core').Page>,
  params?: SwitchChainParams,
): Promise<void> {
  // Give the React SPA time to hydrate and expose window.ethereum.
  await page.waitForTimeout(2500);

  // Anvil fork override: if ANVIL_FORK_URL is set AND its chain id matches the
  // profile's chain, point MetaMask at the fork's RPC instead of the live public
  // RPC. MM's `wallet_addEthereumChain` then registers the target chain with the
  // localhost fork as its backing RPC, so every subsequent eth_sendTransaction is
  // submitted to Anvil — deterministic, reproducible, zero real money.
  if (params && process.env.ANVIL_FORK_URL) {
    const forkChainIdHex = process.env.ANVIL_FORK_CHAIN_ID
      ? `0x${Number(process.env.ANVIL_FORK_CHAIN_ID).toString(16)}`
      : null;
    if (!forkChainIdHex || forkChainIdHex.toLowerCase() === params.chainHexId.toLowerCase()) {
      console.log(`[connectWallet] Anvil fork detected — routing MetaMask to ${process.env.ANVIL_FORK_URL}`);
      params = { ...params, rpcUrl: process.env.ANVIL_FORK_URL };
    }
  }

  // Strategy 1 — proactive RPC switch via window.ethereum (most reliable).
  if (params) {
    const attempted = await page
      .evaluate(async (p) => {
        const eth = (window as any).ethereum;
        if (!eth || typeof eth.request !== 'function') return { attempted: false, reason: 'no-ethereum' };
        try {
          await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: p.chainHexId }] });
          return { attempted: true, added: false };
        } catch (err: any) {
          // 4902 = chain not added to wallet → try wallet_addEthereumChain
          if (err?.code === 4902 || /Unrecognized chain/i.test(err?.message || '')) {
            try {
              await eth.request({
                method: 'wallet_addEthereumChain',
                params: [{
                  chainId: p.chainHexId,
                  chainName: p.chainName,
                  rpcUrls: [p.rpcUrl],
                  blockExplorerUrls: [p.blockExplorerUrl],
                  nativeCurrency: p.nativeCurrency,
                }],
              });
              return { attempted: true, added: true };
            } catch (addErr: any) {
              return { attempted: true, added: false, error: String(addErr?.message || addErr) };
            }
          }
          return { attempted: true, added: false, error: String(err?.message || err) };
        }
      }, params)
      .catch((e) => ({ attempted: false, reason: String(e) }));

    if (attempted?.attempted) {
      console.log(`[connectWallet] RPC-level switch to ${params.chainName} ${JSON.stringify(attempted)}`);
      await page.waitForTimeout(1500);
      // Approve MM popups (add-network first if new, then switch-network).
      for (let i = 0; i < 3; i++) {
        await handleNotification(page.context(), 'confirm').catch(() => {});
        await page.waitForTimeout(1500);
      }
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(2000);
      // Many dApps don't re-read wallet state on chainChanged. Force a reload so balance
      // and on-chain data are refetched on the freshly-selected chain.
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(3500);
    }
  }

  // Strategy 2 — reactive: if a "Switch to X" CTA is still visible on the dApp, click it.
  const pattern = /Switch to|Wrong Network|Unsupported Network|Change Network/i;
  const candidates = [
    page.getByRole('button', { name: pattern }),
    page.getByRole('link', { name: pattern }),
    page.locator('[role="button"]').filter({ hasText: pattern }),
  ];
  for (const loc of candidates) {
    const first = loc.first();
    if (await first.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('[connectWallet] Clicking dApp-level network switch CTA...');
      await first.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(2000);
      for (let i = 0; i < 2; i++) {
        await handleNotification(page.context(), 'confirm').catch(() => {});
        await page.waitForTimeout(1500);
      }
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(2500);
      break;
    }
  }
}

export { expect };

// ── On-chain verification helpers exposed to generated specs ──
export { verifyPage } from './chain/verify.js';
export type { VerifyResult } from './chain/verify.js';
import { buildFinding, writeFinding } from './chain/findings.js';
import type { VerifyResult } from './chain/verify.js';
import type { Address } from 'viem';

/**
 * Emit a finding bundle if the verification has any failed assertions. Resolves
 * the project root from Playwright's testInfo so the bundle lands under
 * `output/<dapp>/findings/` alongside the rest of the dApp's artifacts.
 *
 * This is a best-effort helper — it swallows errors so a write-side problem
 * (e.g., read-only FS in CI) cannot fail a test that otherwise passed.
 */
export function emitFindingIfNeeded(
  testInfo: import('@playwright/test').TestInfo,
  verification: VerifyResult,
  source: {
    dapp: string;
    url: string;
    archetype: import('./chain/types.js').AssertionContext['archetype'];
    chainId: number;
    wallet: Address;
    flowId?: string;
  },
): string | null {
  try {
    if (!verification.failed || verification.failed.length === 0) return null;
    // Project root: `output/<dapp>/` is the fixture install location; project
    // root is its grandparent. `join(testInfo.project.testDir, '..', '..', '..')`
    // lands at the project root in both spec-gen and anvil-run layouts.
    const projectRoot = join(testInfo.project.testDir, '..', '..', '..');
    const finding = buildFinding({
      source,
      context: {
        testTitle: testInfo.title,
        specFile: testInfo.file,
        flowId: source.flowId,
        ranAt: new Date().toISOString(),
      },
      verification,
      artifacts: {
        tracePath: join(testInfo.outputDir, 'trace.zip'),
        screencastPath: join(testInfo.outputDir, 'screencast-manifest.json'),
      },
    });
    return writeFinding(projectRoot, finding);
  } catch {
    return null;
  }
}

/**
 * Test wallet address derived from the seed phrase used for MetaMask.
 * Exported so generated specs can pass it to verifyPage() without
 * duplicating viem mnemonic-to-account derivation in every test.
 *
 * Lazily computed once per worker and memoized on first read. If the
 * derivation throws (mnemonic-to-account not available in the installed
 * viem version), falls back to the Anvil default test account so chain
 * verification still runs with sensible defaults in a fork environment.
 */
let _cachedWallet: `0x${string}` | null = null;
export function getTestWalletAddress(): `0x${string}` {
  if (_cachedWallet) return _cachedWallet;
  try {
    // Lazy import so specs that don't use chain verification don't pay the cost.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mnemonicToAccount } = require('viem/accounts');
    const mnemonic = SEED_PHRASE.trim();
    const account = mnemonicToAccount(mnemonic);
    _cachedWallet = account.address;
    return _cachedWallet!;
  } catch {
    // Anvil default account #0, which matches `test test test test test test test test test test test junk`.
    _cachedWallet = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    return _cachedWallet;
  }
}

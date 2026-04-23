import type { BrowserContext, Page } from 'playwright-core';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Import wallet into MetaMask via Playwright UI automation.
 * Uses getByRole/getByText which pierce Shadow DOM — NOT evaluate() or data-testid.
 * Handles MetaMask 13.x onboarding flow (2025/2026).
 */
export async function setupMetaMask(
  context: BrowserContext,
  seedPhrase: string,
  password: string = 'Web3QaAgent!2026',
): Promise<void> {
  await sleep(3000);

  // Find or open MetaMask page
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
  if (!mm) {
    console.warn('[MetaMask] Could not find MetaMask page');
    return;
  }

  const extId = new URL(mm.url()).hostname;

  // Make sure we're on onboarding
  if (!mm.url().includes('onboarding')) {
    await mm.goto(`chrome-extension://${extId}/home.html#onboarding/welcome`);
    await sleep(4000);
  }

  // Check if we're actually on onboarding or already set up
  const isOnboarding = mm.url().includes('onboarding') ||
    await mm.getByRole('button', { name: /I have an existing wallet/i }).isVisible({ timeout: 3000 }).catch(() => false) ||
    await mm.getByRole('button', { name: /Create a new wallet/i }).isVisible({ timeout: 2000 }).catch(() => false);

  if (!isOnboarding) {
    // Check if MetaMask is on the lock screen (needs password unlock)
    const passwordInput = mm.locator('input[type="password"]').first();
    const isLocked = await passwordInput.isVisible({ timeout: 3000 }).catch(() => false);
    if (isLocked) {
      console.log('[MetaMask] Wallet locked, unlocking...');
      await passwordInput.fill(password);
      await sleep(500);
      const unlockBtn = mm.getByRole('button', { name: /Unlock/i }).first();
      if (await unlockBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await unlockBtn.click();
        await sleep(3000);
        console.log('[MetaMask] Wallet unlocked!');
      }
    } else {
      console.log('[MetaMask] Wallet already imported and unlocked, skipping setup');
    }
    return;
  }

  console.log('[MetaMask] Starting wallet import...');

  try {
    // Step 1: Click "I have an existing wallet"
    console.log('[MetaMask] Step 1: Existing wallet...');
    await clickBtn(mm, 'I have an existing wallet');
    await sleep(3000);

    // Step 2: Click "Import using Secret Recovery Phrase" (new in MM 13.x)
    console.log('[MetaMask] Step 2: Import using SRP...');
    await clickBtn(mm, 'Import using Secret Recovery Phrase');
    await sleep(3000);

    // Step 3: Enter seed phrase
    console.log('[MetaMask] Step 3: Entering seed phrase...');
    const words = seedPhrase.trim().split(/\s+/);

    // Try textarea first (some MM versions)
    const textarea = mm.locator('textarea').first();
    if (await textarea.isVisible({ timeout: 3000 }).catch(() => false)) {
      await textarea.click();
      await textarea.pressSequentially(seedPhrase, { delay: 20 });
    } else {
      // Try individual word inputs
      for (let i = 0; i < words.length; i++) {
        // Try multiple selector patterns
        const input = mm.locator(`input[data-testid="import-srp__srp-word-${i}"]`)
          .or(mm.locator(`#import-srp__srp-word-${i}`));
        if (await input.isVisible({ timeout: 1500 }).catch(() => false)) {
          await input.fill(words[i]);
        }
      }
    }
    await sleep(2000);

    // Step 4: Confirm SRP
    console.log('[MetaMask] Step 4: Confirming SRP...');
    for (const label of ['Confirm Secret Recovery Phrase', 'Confirm', 'Continue', 'Import', 'Next', 'Submit']) {
      if (await clickBtn(mm, label)) break;
    }
    await sleep(5000);

    // Step 5: Set password
    console.log('[MetaMask] Step 5: Setting password...');
    const pwInputs = mm.locator('input[type="password"]');
    // Wait longer for password inputs — MM can be slow after SRP validation
    await pwInputs.first().waitFor({ timeout: 20000 }).catch(() => {
      console.warn('[MetaMask] Password fields did not appear after 20s — trying to proceed anyway');
    });
    const pwCount = await pwInputs.count();
    console.log(`[MetaMask]   Found ${pwCount} password fields`);
    if (pwCount >= 2) {
      await pwInputs.nth(0).fill(password);
      await pwInputs.nth(1).fill(password);
    }

    // Check any checkboxes (terms)
    const checkboxes = mm.locator('input[type="checkbox"]');
    const cbCount = await checkboxes.count();
    for (let i = 0; i < cbCount; i++) {
      if (!(await checkboxes.nth(i).isChecked().catch(() => true))) {
        await checkboxes.nth(i).click({ force: true }).catch(() => {});
      }
    }
    await sleep(1000);

    // Step 6: Submit (button text varies by MM version)
    console.log('[MetaMask] Step 6: Importing wallet...');
    await clickBtn(mm, 'Create password') ||
      await clickBtn(mm, 'Import my wallet') ||
      await clickBtn(mm, 'Confirm') ||
      await clickBtn(mm, 'Continue');
    await sleep(10000);

    // Step 7: Dismiss post-setup screens
    console.log('[MetaMask] Step 7: Post-setup...');
    for (const label of ['Got it', 'Done', 'Next', 'Continue', 'Open wallet', 'Close', 'Skip', 'Not now']) {
      await clickBtn(mm, label);
      await sleep(800);
    }
    // Try again for multi-screen dismissals
    for (const label of ['Got it', 'Done', 'Next']) {
      await clickBtn(mm, label);
      await sleep(800);
    }

    console.log('[MetaMask] Wallet imported successfully!');

  } catch (e) {
    console.error(`[MetaMask] Setup error: ${(e as Error).message}`);
    try { await mm.screenshot({ path: '/tmp/metamask-error.png' }); } catch {}
  }
}

async function clickBtn(page: Page, name: string): Promise<boolean> {
  try {
    const btn = page.getByRole('button', { name: new RegExp(name, 'i') });
    if (await btn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.first().click();
      return true;
    }
  } catch {}
  // Fallback: try getByText for non-button clickable elements
  try {
    const el = page.getByText(name, { exact: false }).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      await el.click();
      return true;
    }
  } catch {}
  return false;
}

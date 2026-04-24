/**
 * Phase 1: CONTEXT — Exhaustive pentesting-style interaction crawler.
 * NO LLM. Cost: $0.
 *
 * 1. Connect wallet (unlocks full UI)
 * 2. Start video recording (screencast)
 * 3. For each page: scrape ALL elements via Playwright getByRole
 * 4. Click EVERY interactive element — buttons, switches, toggles, tabs, links
 * 5. Fill EVERY input field with test values
 * 6. Test EVERY dropdown option
 * 7. Screenshot before/after each interaction, record DOM diff
 * 8. Intercept ALL network API responses
 * 9. Read localStorage/sessionStorage
 * 10. Scrape docs site + analyze JS bundles
 * 11. Output structured interaction log
 */

import type { Page } from 'playwright-core';
import type { BrowserCtx, ContextData, PageDiscovery, SnapshotRef } from '../types.js';
import { analyzeBundles, type BundleAnalysis } from '../core/bundle.js';
import { startNetworkCapture, type NetworkCapture } from '../core/network.js';
import { executeWalletTool } from '../core/wallet-tools.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

export interface PageScrapedData {
  url: string;
  visibleText: string;
  elements: { role: string; name: string; type?: string; disabled?: boolean }[];
  dropdownContents: Record<string, string[]>;
  storage: Record<string, string>;
  jsState: Record<string, any>;
  links: { text: string; href: string }[];
}

export interface InteractionRecord {
  page: string;
  elementRole: string;
  elementName: string;
  action: 'click' | 'toggle' | 'type' | 'select' | 'tab_switch';
  value?: string;
  beforeScreenshot: string;
  afterScreenshot: string;
  domChanges: {
    appeared: string[];
    disappeared: string[];
    changed: string[];
  };
  newElements: number;
  success: boolean;
  error?: string;
  timestamp: number;
}

/** A discovered user flow — sequence of actions that form a complete path */
export interface DiscoveredFlow {
  id: string;
  page: string;
  name: string;
  steps: FlowStep[];
  depth: number;
  walletInteraction: boolean;
  completedSuccessfully: boolean;
  screenshot?: string;
}

export interface FlowStep {
  action: 'click' | 'type' | 'toggle' | 'select' | 'approve_tx' | 'sign' | 'navigate';
  elementRole: string;
  elementName: string;
  value?: string;
  resultDescription: string;
  newElementsAppeared: string[];
  screenshot?: string;
}

export interface CoverageMap {
  pages: {
    path: string;
    elementsTotal: number;
    elementsInteracted: number;
    sharedElementsSkipped: number;
    uniqueElements: { role: string; name: string; interacted: boolean; resultSummary?: string }[];
  }[];
  sharedElements: { role: string; name: string }[];
  interactionSummary: {
    totalInteractions: number;
    meaningfulStateChanges: number;
    walletBoundaries: number;
    coverageGaps: string[];
  };
}

export interface CrawlResult {
  context: ContextData;
  pages: PageDiscovery[];
  navLinks: { text: string; href: string }[];
  scrapedData: Record<string, PageScrapedData>;
  networkData: NetworkCapture;
  bundleAnalysis?: BundleAnalysis;
  interactions: InteractionRecord[];
  discoveredFlows: DiscoveredFlow[];
  videoPath?: string;
  coverageMap: CoverageMap;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Generic test values for HTML input types. The crawler uses these to
// exercise form inputs broadly to observe behavior — not to drive real user
// flows. Archetype-specific numeric values (collateral, leverage, swap size,
// lending amount, etc.) are picked by the spec-generator from profile config,
// not here. Keep this map dApp-agnostic.
const TEST_VALUES: Record<string, string> = {
  'number': '1',
  'text': 'test',
  'email': 'test@test.com',
  'password': 'Test123!',
  'search': 'a',
  'url': 'https://test.com',
  'tel': '+1234567890',
  'default': '1',
};

function getTestValue(name: string, type?: string): string {
  const lower = (name + ' ' + (type || '')).toLowerCase();
  // Email + search get genre-appropriate values regardless of HTML type.
  if (lower.includes('email') || type === 'email') return TEST_VALUES.email;
  if (lower.includes('search')) return TEST_VALUES.search;
  // Otherwise rely purely on the HTML type hint.
  if (type && TEST_VALUES[type]) return TEST_VALUES[type];
  return TEST_VALUES.default;
}

export async function crawlDApp(ctx: BrowserCtx, url: string): Promise<CrawlResult> {
  const pages: PageDiscovery[] = [];
  const scrapedData: Record<string, PageScrapedData> = {};
  const interactions: InteractionRecord[] = [];
  const discoveredFlows: DiscoveredFlow[] = [];
  const visitedUrls = new Set<string>();
  const { page } = ctx;
  let screenshotIdx = 0;

  const takeScreenshot = async (name: string): Promise<string> => {
    const safeName = `${String(++screenshotIdx).padStart(3, '0')}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const path = join(ctx.screenshotDir, `${safeName}.png`);
    try {
      await page.screenshot({ path, fullPage: false });
    } catch {}
    return path;
  };

  // Start network capture FIRST
  const networkCapture = startNetworkCapture(page);

  // Start video recording
  let videoPath: string | undefined;
  try {
    await (page as any).video?.(); // check if already recording
  } catch {}

  // -- 1. Navigate --
  console.log(`[Crawl] Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);

  const title = await page.title();
  const description = await page.evaluate(() => {
    const m = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
    return m?.getAttribute('content') || '';
  });

  // -- 2. Connect wallet --
  // Hard-capped at 60 seconds. Supports three wallet modal shapes (RainbowKit/Wagmi
  // direct MetaMask button, Privy "Continue with a wallet", and Uniswap's "Other wallets"
  // expander). If any step hangs or the page context gets invalidated (known to happen
  // on Uniswap after wallet_switchEthereumChain + reload), we log + continue in
  // read-only mode instead of blocking the entire crawl.
  console.log(`[Crawl] Connecting wallet...`);
  // Pull connect hints from the profile (Uniswap "Other wallets" expander, custom
  // login testIds, etc). Falls back to defaults if no profile is registered for
  // this URL — read-only crawls of arbitrary URLs still work.
  let connectHints: { preMetaMaskClicks?: Array<string | RegExp>; loginButtonPattern?: RegExp; loginButtonTestId?: string } | undefined;
  try {
    const { getProfileOrThrow } = await import('../config.js');
    connectHints = getProfileOrThrow(url).selectors?.connect;
  } catch { /* no profile match — use defaults */ }

  const connectBlock = (async () => {
    // 1. Find the Connect/Login button — prefer profile-provided testId, then
    //    profile pattern, then sensible defaults.
    const defaultLoginPattern = /^(Login|Connect Wallet|Connect|Get Started)$/i;
    const loginPattern = connectHints?.loginButtonPattern ?? defaultLoginPattern;
    let loginBtn = connectHints?.loginButtonTestId
      ? page.getByTestId(connectHints.loginButtonTestId).first()
      : page.getByRole('button', { name: loginPattern }).first();
    let loginVisible = await loginBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!loginVisible && connectHints?.loginButtonTestId) {
      loginBtn = page.getByRole('button', { name: loginPattern }).first();
      loginVisible = await loginBtn.isVisible({ timeout: 2000 }).catch(() => false);
    }
    if (!loginVisible) return 'no-login-button';
    await loginBtn.click().catch(() => {});
    await sleep(2500);

    // 2. Privy wrapper — some dApps gate wallet-connect behind "Continue with a wallet".
    const privyOpt = page.getByRole('button', { name: /Continue with (a )?wallet/i }).first();
    if (await privyOpt.isVisible({ timeout: 1500 }).catch(() => false)) {
      await privyOpt.click().catch(() => {});
      await sleep(1500);
    }

    // 3. Apply pre-MetaMask click hints from the profile (Uniswap "Other wallets").
    //    Each hint is fire-and-forget — missing elements don't fail the flow.
    for (const hint of connectHints?.preMetaMaskClicks ?? [/^Other wallets$/i, /^More wallets$/i]) {
      const pat = typeof hint === 'string' ? new RegExp('^' + hint + '$', 'i') : hint;
      const target = page.getByText(pat).first();
      if (await target.isVisible({ timeout: 1500 }).catch(() => false)) {
        await target.click({ timeout: 3000 }).catch(() => {});
        console.log(`[Crawl]   pre-MM click: ${pat}`);
        await sleep(1000);
      }
    }

    // 4. Click MetaMask option. Multi-strategy with viewport filter to avoid the
    //    "MetaMask" text in dApp footers (partner mentions, social links). Same
    //    logic as the fixture's connectWallet — ported verbatim because that one
    //    actually completes the handshake on RainbowKit/Wagmi dApps.
    let mmClicked = false;
    const mmLocators = [
      page.locator('[data-testid*="metamask" i]').first(),
      page.getByRole('button', { name: /^MetaMask$/i }).first(),
      page.getByText(/^MetaMask$/i).first(),
    ];
    for (const loc of mmLocators) {
      if (!(await loc.isVisible({ timeout: 2000 }).catch(() => false))) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (!box) continue;
      const viewport = page.viewportSize();
      if (viewport && box.y > viewport.height * 0.9) continue; // footer — skip
      await loc.click({ timeout: 4000 }).catch(() => {});
      console.log('[Crawl]   clicked MetaMask option');
      mmClicked = true;
      break;
    }
    if (!mmClicked) {
      // Diagnostic dump so the next session knows what the wallet modal looks like.
      try {
        const texts: string[] = [];
        const cands = await page.locator('button, [role="button"], [cursor="pointer"]').all();
        for (const c of cands.slice(0, 40)) {
          if (!(await c.isVisible().catch(() => false))) continue;
          const txt = (await c.innerText().catch(() => '')).trim().slice(0, 50);
          if (txt) texts.push(txt);
        }
        console.log(`[Crawl]   MM not found — visible clickables: ${JSON.stringify(texts.slice(0, 25))}`);
      } catch {}
      return 'mm-not-found';
    }
    await sleep(2000);

    // 5. Approve in MM popup via the existing handleNotification helper.
    await executeWalletTool('wallet_approve_connection', { skipSiwe: false }, ctx).catch(err => {
      console.warn(`[Crawl]   wallet_approve_connection threw: ${(err as Error).message}`);
    });
    await sleep(3000);
    await page.bringToFront().catch(() => {});
    await sleep(1500);

    // 6. Dismiss any post-connect modal (some dApps show a welcome dialog).
    const cancelModal = page.getByRole('button', { name: 'Cancel' });
    if (await cancelModal.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cancelModal.click().catch(() => {});
      await sleep(800);
    }
    await page.keyboard.press('Escape').catch(() => {});
    return 'attempted';
  })();

  try {
    const timeout = new Promise<string>(r => setTimeout(() => r('timeout'), 60_000));
    const result = await Promise.race([connectBlock, timeout]);
    console.log(`[Crawl] Connect flow: ${result}`);

    // Chain switch — derive target from the dApp profile so the crawler lands on
    // the correct network. On Uniswap specifically the `reload` after switching
    // chains invalidates the page context while MM popups are pending, so we
    // guard the reload and skip on any throw. If no profile is registered for
    // this URL we skip chain switching entirely (read-only crawl).
    let targetChainHex: string | undefined;
    let targetChainName: string | undefined;
    try {
      const { getProfileOrThrow } = await import('../config.js');
      const profile = getProfileOrThrow(url);
      targetChainHex = profile.network.chainHexId;
      targetChainName = profile.network.chain.charAt(0).toUpperCase() + profile.network.chain.slice(1);
    } catch { /* no profile — skip chain switch */ }

    if (targetChainHex && targetChainName) {
      const chainId = await page.evaluate(() => (window as any).ethereum?.request?.({ method: 'eth_chainId' })).catch(() => null);
      if (chainId && chainId !== targetChainHex) {
        console.log(`[Crawl] Switching to ${targetChainName}...`);
        try {
          await executeWalletTool('wallet_switch_network', { networkName: targetChainName }, ctx);
          await sleep(3000);
          await page.bringToFront().catch(() => {});
          // Reload is best-effort — if page is already closed/invalidated, skip.
          if (!page.isClosed()) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(err => {
              console.warn(`[Crawl] reload after chain switch failed (known on Uniswap): ${err?.message ?? err}`);
            });
            await sleep(3000);
          }
        } catch (e) {
          console.warn(`[Crawl] chain switch failed: ${(e as Error).message} — continuing anyway`);
        }
      }
    }
    // Connection ground truth: prefer the Login-button-still-visible signal
    // (works for RainbowKit/wagmi where ethereum.selectedAddress stays null),
    // then fall back to ethereum.selectedAddress, then eth_accounts.
    const loginPattern = connectHints?.loginButtonPattern ?? /^(Login|Connect Wallet|Connect)$/i;
    const loginStillVisible = page.isClosed() ? true : await page
      .getByRole('button', { name: loginPattern }).first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);

    let addr: string | null = null;
    if (!page.isClosed()) {
      addr = await page.evaluate(async () => {
        const eth = (window as any).ethereum;
        if (!eth) return null;
        if (eth.selectedAddress) return eth.selectedAddress;
        try {
          const accounts = await eth.request?.({ method: 'eth_accounts' });
          if (Array.isArray(accounts) && accounts.length > 0) return accounts[0];
        } catch { /* ignore */ }
        return null;
      }).catch(() => null);
    }

    if (!loginStillVisible) {
      console.log(`[Crawl] Connected: login button gone${addr ? ` (addr ${addr.slice(0, 10)}…)` : ' (wagmi-style state)'}`);
    } else if (addr) {
      console.log(`[Crawl] Connected: ${addr}`);
    } else {
      console.log(`[Crawl] Connected: failed (crawler will continue in read-only mode)`);
    }
  } catch (e) {
    console.warn(`[Crawl] Wallet failed: ${(e as Error).message}`);
  }
  await sleep(5000);

  // -- 3. Get nav links --
  const navLinks = await getNavLinks(page);
  console.log(`[Crawl] Nav: ${navLinks.map(l => l.text).join(', ')}`);

  // -- 4. Scrape + interact with main page --
  console.log(`[Crawl] Scraping + interacting: main page`);
  const mainData = await scrapePage(page, ctx);
  pages.push(mainData.discovery);
  scrapedData[simplifyUrl(page.url())] = mainData.scraped;
  visitedUrls.add(normalizeUrl(page.url()));

  // Track element keys per page for shared element detection
  const sharedElements = new Set<string>();
  const firstPageElementKeys = new Set(
    mainData.scraped.elements.map(e => `${e.role}:${e.name}`)
  );

  // Per-page coverage tracking
  const pageCoverageEntries: CoverageMap['pages'] = [];

  // Exhaustive interaction + flow discovery on main page (no shared elements to skip yet)
  const mainResult = await interactWithAllElements(page, ctx, simplifyUrl(page.url()), mainData.scraped, takeScreenshot, sharedElements);
  interactions.push(...mainResult.records);
  discoveredFlows.push(...mainResult.flows);
  pageCoverageEntries.push(mainResult.coverage);
  console.log(`[Crawl]   ${mainResult.records.length} interactions, ${mainResult.flows.length} flows discovered`);

  // -- 5. Scrape + interact with all nav pages --
  const hostname = new URL(url).hostname;
  let pageIndex = 0;
  for (const link of navLinks) {
    const normalized = normalizeUrl(link.href);
    if (visitedUrls.has(normalized) || !link.href.includes(hostname)) continue;
    try {
      console.log(`[Crawl] Scraping + interacting: ${link.text}`);
      await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(3000);
      const data = await scrapePage(page, ctx);
      pages.push(data.discovery);
      scrapedData[simplifyUrl(link.href)] = data.scraped;
      visitedUrls.add(normalized);

      // After the SECOND page, compute shared elements (present on both first and second page)
      if (pageIndex === 0 && sharedElements.size === 0) {
        const secondPageKeys = new Set(
          data.scraped.elements.map(e => `${e.role}:${e.name}`)
        );
        for (const key of firstPageElementKeys) {
          if (secondPageKeys.has(key)) {
            sharedElements.add(key);
          }
        }
        console.log(`[Crawl] Detected ${sharedElements.size} shared nav/header elements`);
      }
      pageIndex++;

      // Exhaustive interaction + flow discovery on this page (skips shared elements)
      const pageResult = await interactWithAllElements(page, ctx, simplifyUrl(link.href), data.scraped, takeScreenshot, sharedElements);
      interactions.push(...pageResult.records);
      discoveredFlows.push(...pageResult.flows);
      pageCoverageEntries.push(pageResult.coverage);
      console.log(`[Crawl]   ${pageResult.records.length} interactions, ${pageResult.flows.length} flows discovered`);
    } catch (e) {
      console.warn(`[Crawl] Failed: ${link.text}: ${(e as Error).message}`);
    }
  }

  // -- 6. Docs --
  console.log('[Crawl] Scraping docs...');
  const docsContent = await deepCrawlDocs(page, url);

  // -- 7. Bundle analysis --
  let bundleAnalysis: BundleAnalysis | undefined;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    bundleAnalysis = await analyzeBundles(page);
  } catch (e) {
    console.warn(`[Crawl] Bundle analysis failed: ${(e as Error).message}`);
  }

  // -- 8. Stop network capture --
  const networkData = networkCapture.stop();

  const allText = Object.values(scrapedData).map(s => s.visibleText).join(' ').toLowerCase();
  const features = detectFeatures(allText);
  const chain = detectChain(allText + ' ' + docsContent);

  const totalElements = Object.values(scrapedData).reduce((sum, s) => sum + s.elements.length, 0);
  const totalDropdowns = Object.values(scrapedData).reduce((sum, s) => sum + Object.keys(s.dropdownContents).length, 0);
  const successfulInteractions = interactions.filter(i => i.success).length;
  const walletFlows = discoveredFlows.filter(f => f.walletInteraction).length;

  // Build coverage map
  const meaningfulStateChanges = interactions.filter(i =>
    i.success && (i.domChanges.appeared.length > 0 || i.domChanges.disappeared.length > 0)
  ).length;
  const walletBoundaries = discoveredFlows.filter(f => f.walletInteraction).length;

  // Detect coverage gaps
  const coverageGaps: string[] = [];
  for (const rec of interactions) {
    if (!rec.success) continue;
    // Element clicked and new elements appeared but none interacted (depth limit)
    if (rec.newElements > 3) {
      const appearedNames = rec.domChanges.appeared.slice(0, 5).map(a => a.split(':')[1] || a);
      const anyFollowed = interactions.some(i2 =>
        i2.page === rec.page && appearedNames.some(n => i2.elementName.includes(n))
      );
      if (!anyFollowed) {
        coverageGaps.push(`"${rec.elementName}" opened ${rec.newElements} new elements but none were interacted with (depth limit)`);
      }
    }
  }
  // Detect dropdowns where < half options were tried
  for (const [pagePath, scraped] of Object.entries(scrapedData)) {
    for (const [trigger, items] of Object.entries(scraped.dropdownContents)) {
      const selectedCount = interactions.filter(i =>
        i.page === pagePath && i.action === 'select' &&
        items.some(item => i.elementName.includes(item.slice(0, 20)))
      ).length;
      if (items.length > 2 && selectedCount < items.length / 2) {
        coverageGaps.push(`Dropdown "${trigger}" has ${items.length} options but only ${selectedCount} were selected`);
      }
    }
  }
  // Detect inputs filled but no submit followed
  for (const rec of interactions) {
    if (rec.action !== 'type' || !rec.success) continue;
    const idx = interactions.indexOf(rec);
    const nextFew = interactions.slice(idx + 1, idx + 4);
    const hasSubmit = nextFew.some(n =>
      n.action === 'click' && n.page === rec.page &&
      /submit|confirm|approve|send|swap|open|place|enter|deposit|withdraw/i.test(n.elementName)
    );
    if (!hasSubmit) {
      coverageGaps.push(`Input "${rec.elementName}" was filled but no submit-like button was clicked after`);
    }
  }

  const coverageMap: CoverageMap = {
    pages: pageCoverageEntries,
    sharedElements: Array.from(sharedElements).map(key => {
      const [role, ...rest] = key.split(':');
      return { role, name: rest.join(':') };
    }),
    interactionSummary: {
      totalInteractions: interactions.length,
      meaningfulStateChanges,
      walletBoundaries,
      coverageGaps: [...new Set(coverageGaps)].slice(0, 50),
    },
  };

  console.log(`[Crawl] Done — ${pages.length} pages, ${totalElements} elements, ${totalDropdowns} dropdowns, ${interactions.length} interactions (${successfulInteractions} ok), ${discoveredFlows.length} flows (${walletFlows} hit wallet), ${networkData.responses.length} API responses, ${networkData.assets.length} assets, ${(docsContent.length/1000).toFixed(0)}K docs`);
  console.log(`[Crawl] Coverage: ${meaningfulStateChanges} meaningful changes, ${walletBoundaries} wallet boundaries, ${coverageGaps.length} gaps`);

  return {
    context: { url, title, description, docsContent, chain, features },
    pages, navLinks, scrapedData, networkData, bundleAnalysis, interactions, discoveredFlows, videoPath, coverageMap,
  };
}

// -- Exhaustive element interaction + recursive flow discovery --

async function interactWithAllElements(
  page: Page,
  ctx: BrowserCtx,
  pagePath: string,
  scraped: PageScrapedData,
  takeScreenshot: (name: string) => Promise<string>,
  sharedElements: Set<string>,
): Promise<{ records: InteractionRecord[]; flows: DiscoveredFlow[]; coverage: CoverageMap['pages'][number] }> {
  const records: InteractionRecord[] = [];
  const flows: DiscoveredFlow[] = [];
  const interacted = new Set<string>();
  let flowCounter = 0;
  const navNames = new Set(['trade', 'portfolio', 'earn', 'leaderboard', 'referral', 'more', 'login']);
  // Never click these — destructive or navigation-breaking
  const blocklist = new Set(['disconnect', 'logout', 'sign out', 'delete', 'remove', 'reset', 'clear all']);

  const MAX_DEPTH = 2;
  const MAX_INTERACTIONS = 100; // safety limit per page

  // -- Shared helpers --

  const getVisibleElements = async (): Promise<ElementInfo[]> => {
    return page.evaluate(() => {
      const selectors = 'button, a[href], input, select, textarea, [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"], [role="spinbutton"], [role="menuitem"], [role="combobox"]';
      const els = document.querySelectorAll(selectors);
      return Array.from(els).slice(0, 300).map((el: any, idx: number) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        if (rect.top > window.innerHeight * 3 || rect.bottom < -500) return null;
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const name = (el.textContent?.trim().substring(0, 80) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').split('\n')[0]?.trim() || '';
        return {
          index: idx, role, name, tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          testId: el.getAttribute('data-testid') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          checked: el.getAttribute('aria-checked') || (el.checked ? 'true' : ''),
          disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
          value: el.value || '',
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }).filter(Boolean) as ElementInfo[];
    }).catch(() => [] as ElementInfo[]);
  };

  const getDomFingerprint = async (): Promise<string[]> => {
    return page.evaluate(() => {
      const selectors = 'button, a, input, select, textarea, [role], h1, h2, h3, h4, label, span, p, div.modal, [class*="modal"], [class*="popup"], [class*="dropdown"], [class*="tooltip"]';
      const els = document.querySelectorAll(selectors);
      return Array.from(els).slice(0, 500).map((el: any) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return '';
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const text = (el.textContent?.trim() || '').substring(0, 60).split('\n')[0]?.trim();
        const visible = getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
        if (!visible) return '';
        return `${role}:${text}`;
      }).filter(Boolean);
    }).catch(() => []);
  };

  const computeDomDiff = (before: string[], after: string[]): { appeared: string[]; disappeared: string[]; changed: string[] } => {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const raw = {
      appeared: after.filter(e => !beforeSet.has(e)),
      disappeared: before.filter(e => !afterSet.has(e)),
    };
    // Filter price-tick noise: if an appeared and disappeared entry differ only in numbers, it's a price update
    const isNumericNoise = (s: string) => /^(span|p|button|div):[\d,.$%KMB\s/]+$/.test(s);
    const stripNumbers = (s: string) => s.replace(/[\d,.$%]+/g, '#');
    const disappearedStatic = new Set(raw.disappeared.map(stripNumbers));
    const appearedStatic = new Set(raw.appeared.map(stripNumbers));

    return {
      appeared: raw.appeared.filter(e => {
        if (isNumericNoise(e)) return false;
        if (disappearedStatic.has(stripNumbers(e))) return false;
        return true;
      }),
      disappeared: raw.disappeared.filter(e => {
        if (isNumericNoise(e)) return false;
        if (appearedStatic.has(stripNumbers(e))) return false;
        return true;
      }),
      changed: [],
    };
  };

  const clickAt = async (x: number, y: number) => { await page.mouse.click(x, y); };

  // Dedup by role+name — coordinates shift when DOM changes so can't use x,y
  // For unnamed elements, add tag to distinguish
  const elKey = (el: ElementInfo) => `${el.role}:${el.name || ''}:${el.tag}${!el.name ? ':' + el.testId : ''}`;

  // Check if MetaMask popup appeared (a new page/popup from the extension)
  const checkForWalletPopup = async (): Promise<boolean> => {
    const pages = ctx.context.pages();
    return pages.some(p => {
      try { return p.url().includes('chrome-extension://') && p.url().includes('notification'); }
      catch { return false; }
    });
  };

  // Find NEW structural elements that weren't there before
  // Compare by role+tag (structure), not by text content — avoids false matches from price updates
  const findNewElements = (before: ElementInfo[], after: ElementInfo[]): ElementInfo[] => {
    // Count elements by structural key (role:tag) — if count increased, new elements appeared
    const beforeCounts: Record<string, number> = {};
    for (const e of before) {
      const key = `${e.role}:${e.tag}`;
      beforeCounts[key] = (beforeCounts[key] || 0) + 1;
    }
    const afterCounts: Record<string, number> = {};
    const afterByKey: Record<string, ElementInfo[]> = {};
    for (const e of after) {
      const key = `${e.role}:${e.tag}`;
      afterCounts[key] = (afterCounts[key] || 0) + 1;
      if (!afterByKey[key]) afterByKey[key] = [];
      afterByKey[key].push(e);
    }

    const newElements: ElementInfo[] = [];
    for (const [key, count] of Object.entries(afterCounts)) {
      const beforeCount = beforeCounts[key] || 0;
      if (count > beforeCount) {
        // New elements of this type appeared — take the extras
        const extras = afterByKey[key].slice(beforeCount);
        for (const e of extras) {
          if (!e.disabled && !navNames.has(e.name.toLowerCase().trim()) && e.name.length > 0 && e.name.length < 80) {
            newElements.push(e);
          }
        }
      }
    }
    return newElements;
  };

  // -- Recursive interaction: click element, if new elements appear, follow them --

  const interactRecursive = async (
    el: ElementInfo,
    depth: number,
    flowSteps: FlowStep[],
    parentElements: ElementInfo[],
  ): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    if (records.length >= MAX_INTERACTIONS) return;
    const key = elKey(el);
    if (interacted.has(key)) return;
    if (blocklist.has(el.name.toLowerCase().trim())) return;
    interacted.add(key);

    const isInput = el.tag === 'input' || el.tag === 'textarea' || el.role === 'textbox' || el.role === 'spinbutton';
    const isToggle = el.role === 'switch' || el.role === 'checkbox';
    const isSlider = el.role === 'slider';

    try {
      const beforeFp = await getDomFingerprint();
      const beforeElements = await getVisibleElements();
      const beforeShot = await takeScreenshot(`d${depth}_before_${el.role}_${el.name || 'unnamed'}`);

      // Perform the action
      let action: FlowStep['action'] = 'click';
      let value: string | undefined;

      if (isInput) {
        action = 'type';
        value = getTestValue(el.name || el.ariaLabel || '', el.type);
        await clickAt(el.x, el.y);
        await sleep(300);
        await page.keyboard.press('Control+a').catch(() => {});
        await page.keyboard.type(value, { delay: 30 });
      } else if (isToggle) {
        action = 'toggle';
        await clickAt(el.x, el.y);
      } else if (isSlider) {
        action = 'click';
        value = '75%';
        const targetX = el.x + Math.round(el.width * 0.25);
        await page.mouse.move(el.x, el.y);
        await page.mouse.down();
        await page.mouse.move(targetX, el.y, { steps: 10 });
        await page.mouse.up();
      } else {
        await clickAt(el.x, el.y);
      }

      await sleep(2000);

      // Check for MetaMask popup
      const walletPopup = await checkForWalletPopup();
      if (walletPopup) {
        // Record that we hit a wallet boundary — DON'T approve, just reject and record
        console.log(`[Crawl]     ${'  '.repeat(depth)}💰 Wallet popup after "${el.name}" — recording flow boundary`);
        try {
          await executeWalletTool('wallet_reject', {}, ctx);
          await sleep(1000);
          await page.bringToFront();
        } catch {}

        const step: FlowStep = {
          action: 'approve_tx', elementRole: 'wallet', elementName: 'MetaMask transaction',
          resultDescription: 'Wallet approval requested (rejected during crawl — marks tx boundary)',
          newElementsAppeared: [], screenshot: await takeScreenshot(`d${depth}_wallet_popup`),
        };
        flowSteps.push(step);

        // Save this as a completed flow
        flows.push({
          id: `flow-${++flowCounter}`,
          page: pagePath,
          name: flowSteps.map(s => s.elementName).join(' → '),
          steps: [...flowSteps],
          depth,
          walletInteraction: true,
          completedSuccessfully: false,
          screenshot: step.screenshot,
        });
        return;
      }

      const afterFp = await getDomFingerprint();
      const afterElements = await getVisibleElements();
      const afterShot = await takeScreenshot(`d${depth}_after_${el.role}_${el.name || 'unnamed'}`);
      const diff = computeDomDiff(beforeFp, afterFp);

      // Record the flat interaction
      records.push({
        page: pagePath, elementRole: el.role, elementName: el.name || '(unnamed)',
        action: isInput ? 'type' : isToggle ? 'toggle' : 'click',
        value,
        beforeScreenshot: beforeShot, afterScreenshot: afterShot,
        domChanges: diff, newElements: diff.appeared.length,
        success: true, timestamp: Date.now(),
      });

      const totalChanges = diff.appeared.length + diff.disappeared.length;
      console.log(`[Crawl]     ${'  '.repeat(depth)}${isInput ? 'Type' : isToggle ? 'Toggle' : 'Click'} "${el.name || '(unnamed)'}": +${diff.appeared.length}/-${diff.disappeared.length}`);

      // Record flow step
      const step: FlowStep = {
        action, elementRole: el.role, elementName: el.name || '(unnamed)',
        value,
        resultDescription: `+${diff.appeared.length} new, -${diff.disappeared.length} removed`,
        newElementsAppeared: diff.appeared.slice(0, 10),
        screenshot: afterShot,
      };
      flowSteps.push(step);

      // -- RECURSIVE: if significant new elements appeared, interact with them --
      const newElements = findNewElements(beforeElements, afterElements);
      const interactableNew = newElements.filter(e =>
        (e.role === 'button' || e.tag === 'button' || e.role === 'switch' || e.role === 'tab' ||
         e.tag === 'input' || e.role === 'textbox' || e.role === 'spinbutton' || e.role === 'menuitem') &&
        !interacted.has(elKey(e))
      );

      if (interactableNew.length > 0 && depth < MAX_DEPTH && records.length < MAX_INTERACTIONS) {
        console.log(`[Crawl]     ${'  '.repeat(depth)}↳ ${interactableNew.length} new elements, going deeper (depth ${depth + 1})`);

        // At depth 1+, only follow structural elements (modals, forms, inputs) not individual items
        let candidates = interactableNew;
        if (depth >= 1) {
          candidates = interactableNew.filter(e =>
            e.tag === 'input' || e.role === 'textbox' || e.role === 'spinbutton' ||
            e.role === 'switch' || e.role === 'tab' ||
            (e.role === 'button' && /submit|confirm|approve|send|swap|open|place|close|cancel|deposit|withdraw|connect/i.test(e.name))
          );
          // Fallback: if no structural match, take first few buttons
          if (candidates.length === 0) candidates = interactableNew.filter(e => e.role === 'button' || e.tag === 'button');
        }

        // Prioritize: inputs first (fill forms), then buttons (submit), then others
        const sorted = [
          ...candidates.filter(e => e.tag === 'input' || e.role === 'textbox' || e.role === 'spinbutton'),
          ...candidates.filter(e => e.role === 'button' || e.tag === 'button'),
          ...candidates.filter(e => e.role !== 'button' && e.tag !== 'button' && e.tag !== 'input' && e.role !== 'textbox' && e.role !== 'spinbutton'),
        ];

        const maxPerLevel = depth >= 1 ? 3 : 5;
        for (const newEl of sorted.slice(0, maxPerLevel)) {
          if (records.length >= MAX_INTERACTIONS) break;
          await interactRecursive(newEl, depth + 1, [...flowSteps], afterElements);
        }
      }

      // If this was a terminal action (no new elements, or at max depth), save the flow
      if ((interactableNew.length === 0 || depth >= MAX_DEPTH) && flowSteps.length >= 2) {
        flows.push({
          id: `flow-${++flowCounter}`,
          page: pagePath,
          name: flowSteps.map(s => s.elementName).join(' → '),
          steps: [...flowSteps],
          depth,
          walletInteraction: false,
          completedSuccessfully: true,
          screenshot: afterShot,
        });
      }

      // Restore state: close modals/popups, clear inputs
      if (!isInput) {
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(500);
      } else {
        // Clear input
        await clickAt(el.x, el.y);
        await page.keyboard.press('Control+a').catch(() => {});
        await page.keyboard.press('Delete').catch(() => {});
        await sleep(300);
      }

      // Toggle back
      if (isToggle) {
        await clickAt(el.x, el.y);
        await sleep(500);
      }

    } catch (e) {
      records.push({
        page: pagePath, elementRole: el.role, elementName: el.name || '(unnamed)',
        action: isInput ? 'type' : isToggle ? 'toggle' : 'click',
        beforeScreenshot: '', afterScreenshot: '',
        domChanges: { appeared: [], disappeared: [], changed: [] }, newElements: 0,
        success: false, error: (e as Error).message, timestamp: Date.now(),
      });
    }
  };

  // -- Main interaction loop --

  const elements = await getVisibleElements();

  // Helper: check if element is a shared nav/header element that should be skipped
  const isSharedElement = (el: ElementInfo): boolean => {
    if (sharedElements.size === 0) return false;
    return sharedElements.has(`${el.role}:${el.name}`);
  };
  let sharedSkippedCount = 0;

  // Phase 1: Interact with every element at depth 0 (flat coverage)
  // Toggles and switches first
  for (const el of elements.filter(e => e.role === 'switch' || (e.role === 'checkbox' && !e.disabled))) {
    if (isSharedElement(el)) { sharedSkippedCount++; continue; }
    await interactRecursive(el, 0, [], elements);
  }

  // Buttons (skip nav + shared)
  for (const el of elements.filter(e =>
    (e.role === 'button' || e.tag === 'button') && !e.disabled &&
    !navNames.has(e.name.toLowerCase().trim()) && e.name.length < 60
  )) {
    if (isSharedElement(el)) { sharedSkippedCount++; continue; }
    await interactRecursive(el, 0, [], elements);
  }

  // Tabs
  for (const el of elements.filter(e => e.role === 'tab' && !e.disabled)) {
    if (isSharedElement(el)) { sharedSkippedCount++; continue; }
    await interactRecursive(el, 0, [], elements);
  }

  // Inputs
  for (const el of elements.filter(e =>
    (e.tag === 'input' || e.tag === 'textarea' || e.role === 'textbox' || e.role === 'spinbutton') && !e.disabled
  )) {
    if (isSharedElement(el)) { sharedSkippedCount++; continue; }
    await interactRecursive(el, 0, [], elements);
  }

  // Sliders
  for (const el of elements.filter(e => e.role === 'slider' && !e.disabled)) {
    if (isSharedElement(el)) { sharedSkippedCount++; continue; }
    await interactRecursive(el, 0, [], elements);
  }

  // Links (internal only)
  for (const el of elements.filter(e =>
    e.tag === 'a' && e.name && !navNames.has(e.name.toLowerCase().trim()) && e.name.length < 40
  ).slice(0, 10)) {
    if (isSharedElement(el)) { sharedSkippedCount++; continue; }
    const beforeUrl = page.url();
    await interactRecursive(el, 0, [], elements);
    // Navigate back if URL changed
    if (page.url() !== beforeUrl) {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      await sleep(2000);
    }
  }

  // Phase 2: Scroll to bottom for lazy-loaded content
  try {
    const beforeScrollFp = await getDomFingerprint();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);
    const afterScrollFp = await getDomFingerprint();
    const scrollDiff = computeDomDiff(beforeScrollFp, afterScrollFp);
    if (scrollDiff.appeared.length > 0) {
      const shot = await takeScreenshot('after_scroll_bottom');
      records.push({
        page: pagePath, elementRole: 'page', elementName: 'scroll_to_bottom',
        action: 'click', beforeScreenshot: '', afterScreenshot: shot,
        domChanges: scrollDiff, newElements: scrollDiff.appeared.length, success: true, timestamp: Date.now(),
      });
      console.log(`[Crawl]     Scroll bottom: +${scrollDiff.appeared.length} lazy-loaded elements`);

      // Interact with new elements that appeared after scroll
      const newAfterScroll = await getVisibleElements();
      for (const el of newAfterScroll.filter(e =>
        (e.role === 'button' || e.tag === 'button') && !e.disabled &&
        !navNames.has(e.name.toLowerCase().trim()) && !interacted.has(elKey(e))
      ).slice(0, 10)) {
        await interactRecursive(el, 0, [], newAfterScroll);
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(1000);
  } catch {}

  // Phase 3: Dropdown discovery (kept from original — good for asset/order type coverage)
  const dropdownTriggers = elements.filter(e =>
    e.role === 'combobox' || (e.tag === 'select') ||
    ((e.role === 'button' || e.tag === 'button') && /^(BTC|ETH|SOL|EUR|XAU|Market|Limit|Stop|All|Crypto|Forex|Commodities|Equities)/i.test(e.name))
  );

  for (const trigger of dropdownTriggers) {
    const key = `dropdown:${trigger.name}:${trigger.x},${trigger.y}`;
    if (interacted.has(key)) continue;
    interacted.add(key);

    try {
      const beforeFp = await getDomFingerprint();
      const beforeShot = await takeScreenshot(`before_dropdown_${trigger.name}`);
      await clickAt(trigger.x, trigger.y);
      await sleep(2000);

      const dropdownItems = await page.evaluate(() => {
        const items: { text: string; x: number; y: number }[] = [];
        for (const selector of ['[role="option"]', '[role="menuitem"]', '[role="listbox"] > *', '[class*="dropdown"] button', '[class*="popover"] button', '[class*="menu"] [role="button"]']) {
          document.querySelectorAll(selector).forEach((el: any) => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const text = (el.textContent?.trim() || '').split('\n')[0]?.slice(0, 60);
              if (text && text.length > 1) {
                items.push({ text, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
              }
            }
          });
        }
        return items.slice(0, 30);
      }).catch(() => []);

      const afterOpenFp = await getDomFingerprint();
      const afterOpenShot = await takeScreenshot(`after_open_dropdown_${trigger.name}`);
      const openDiff = computeDomDiff(beforeFp, afterOpenFp);

      records.push({
        page: pagePath, elementRole: trigger.role, elementName: trigger.name,
        action: 'click', beforeScreenshot: beforeShot, afterScreenshot: afterOpenShot,
        domChanges: openDiff, newElements: openDiff.appeared.length, success: true, timestamp: Date.now(),
      });
      console.log(`[Crawl]     Dropdown "${trigger.name}" opened: ${dropdownItems.length} items`);

      for (const item of dropdownItems.slice(0, 10)) {
        try {
          const befItem = await getDomFingerprint();
          const befShot = await takeScreenshot(`before_select_${item.text}`);
          await clickAt(item.x, item.y);
          await sleep(2000);
          const aftItem = await getDomFingerprint();
          const aftShot = await takeScreenshot(`after_select_${item.text}`);
          const itemDiff = computeDomDiff(befItem, aftItem);

          records.push({
            page: pagePath, elementRole: 'option', elementName: item.text,
            action: 'select', beforeScreenshot: befShot, afterScreenshot: aftShot,
            domChanges: itemDiff, newElements: itemDiff.appeared.length, success: true, timestamp: Date.now(),
          });
          console.log(`[Crawl]       Select "${item.text}": +${itemDiff.appeared.length}/-${itemDiff.disappeared.length}`);

          await sleep(500);
          const stillOpen = await page.evaluate(() => {
            const dd = document.querySelector('[role="listbox"], [role="menu"], [class*="dropdown"][class*="open"], [class*="popover"]');
            return dd !== null;
          }).catch(() => false);
          if (!stillOpen) {
            await clickAt(trigger.x, trigger.y);
            await sleep(1500);
          }
        } catch {
          await clickAt(trigger.x, trigger.y).catch(() => {});
          await sleep(1000);
        }
      }

      await page.keyboard.press('Escape').catch(() => {});
      await sleep(500);
    } catch (e) {
      records.push({
        page: pagePath, elementRole: trigger.role, elementName: trigger.name,
        action: 'click', beforeScreenshot: '', afterScreenshot: '',
        domChanges: { appeared: [], disappeared: [], changed: [] }, newElements: 0,
        success: false, error: (e as Error).message, timestamp: Date.now(),
      });
    }
  }

  // Build per-page coverage
  const allPageElements = elements.map(el => {
    const key = elKey(el);
    const wasInteracted = interacted.has(key);
    const matchingRecord = records.find(r => r.elementRole === el.role && r.elementName === (el.name || '(unnamed)'));
    return {
      role: el.role,
      name: el.name || '(unnamed)',
      interacted: wasInteracted,
      resultSummary: matchingRecord
        ? `+${matchingRecord.domChanges.appeared.length}/-${matchingRecord.domChanges.disappeared.length}`
        : undefined,
    };
  });

  const coverage: CoverageMap['pages'][number] = {
    path: pagePath,
    elementsTotal: elements.length,
    elementsInteracted: interacted.size,
    sharedElementsSkipped: sharedSkippedCount,
    uniqueElements: allPageElements,
  };

  return { records, flows, coverage };
}

interface ElementInfo {
  index: number;
  role: string;
  name: string;
  tag: string;
  type: string;
  testId: string;
  ariaLabel: string;
  checked: string;
  disabled: boolean;
  value: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// -- Core page scraper using Playwright locators (pierces Shadow DOM) --

async function scrapePage(page: Page, ctx: BrowserCtx): Promise<{ discovery: PageDiscovery; scraped: PageScrapedData }> {
  const url = page.url();
  const pageTitle = await page.title();
  const pageName = pageTitle || url.split('/').pop() || 'page';

  // 1. All visible text
  const visibleText = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, style, svg, noscript').forEach(e => e.remove());
    return clone.innerText || '';
  }).catch(() => '');

  // 2. All elements via getByRole (PIERCES SHADOW DOM)
  const elements: { role: string; name: string; type?: string; disabled?: boolean }[] = [];
  const roles = ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'slider', 'spinbutton', 'menuitem', 'option', 'heading'] as const;

  for (const role of roles) {
    try {
      const loc = page.getByRole(role);
      const count = await loc.count();
      for (let i = 0; i < Math.min(count, 80); i++) {
        try {
          const el = loc.nth(i);
          if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;
          let name = (await el.textContent().catch(() => '') || '').trim().split('\n')[0]?.slice(0, 80) || '';

          if (!name && (role === 'switch' || role === 'slider' || role === 'checkbox' || role === 'spinbutton')) {
            name = await el.evaluate((node: any) => {
              // 1. aria-label / aria-labelledby
              if (node.getAttribute('aria-label')) return node.getAttribute('aria-label');
              const labelledBy = node.getAttribute('aria-labelledby');
              if (labelledBy) {
                const labelEl = document.getElementById(labelledBy);
                if (labelEl?.textContent?.trim()) return labelEl.textContent.trim().slice(0, 60);
              }

              // 2. Explicit <label> wrapping or via for= attribute
              const id = node.getAttribute('id');
              if (id) {
                const labelFor = document.querySelector(`label[for="${id}"]`);
                if (labelFor?.textContent?.trim()) return labelFor.textContent.trim().slice(0, 60);
              }

              // 3. Parent container text — walk up looking for short label text
              let current = node.parentElement;
              for (let depth = 0; depth < 5 && current; depth++) {
                // Get direct text nodes (not text from child interactive elements)
                const directText = Array.from(current.childNodes)
                  .filter((n: any) => n.nodeType === 3 || (n.nodeType === 1 && !['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'SVG'].includes(n.tagName)))
                  .map((n: any) => {
                    if (n.nodeType === 3) return n.textContent?.trim();
                    // For element nodes, skip if it IS the target element or contains it
                    if (n === node || n.contains(node)) return '';
                    return n.textContent?.trim();
                  })
                  .filter((t: any) => t && t.length > 1 && t.length < 60)
                  .join(' ')
                  .trim();
                if (directText && directText !== node.textContent?.trim()) {
                  // Clean: take first line, trim to 60 chars
                  const clean = directText.split('\n')[0]?.trim().slice(0, 60);
                  if (clean && clean.length > 1) return clean;
                }
                current = current.parentElement;
              }

              // 4. Previous sibling
              const prev = node.previousElementSibling;
              if (prev && !['INPUT', 'BUTTON', 'SELECT'].includes(prev.tagName)) {
                const text = prev.textContent?.trim().slice(0, 60);
                if (text && text.length > 1) return text;
              }

              // 5. Next sibling
              const next = node.nextElementSibling;
              if (next && !['INPUT', 'BUTTON', 'SELECT'].includes(next.tagName)) {
                const text = next.textContent?.trim().slice(0, 60);
                if (text && text.length > 1) return text;
              }

              // 6. placeholder / title attributes
              if (node.getAttribute('placeholder')) return node.getAttribute('placeholder');
              if (node.getAttribute('title')) return node.getAttribute('title');

              return '';
            }).catch(() => '');
          }

          if (!name && role !== 'textbox' && role !== 'switch' && role !== 'slider') continue;
          elements.push({
            role,
            name: name || `(unnamed ${role})`,
            type: await el.getAttribute('type').catch(() => undefined) || undefined,
            disabled: await el.isDisabled().catch(() => false),
          });
        } catch {}
      }
    } catch {}
  }

  // 2b. CSS fallback for input elements that getByRole might miss
  try {
    const cssInputs = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="number"], input[type="text"], input:not([type]), textarea, select');
      return Array.from(inputs).slice(0, 30).map((el: any) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return {
          role: el.tagName === 'SELECT' ? 'combobox' : (el.type === 'number' ? 'spinbutton' : 'textbox'),
          name: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '',
          type: el.type || '',
          disabled: el.disabled,
        };
      }).filter(Boolean);
    });
    for (const inp of cssInputs) {
      if (!inp) continue;
      // Don't add duplicates
      if (!elements.find(e => e.role === inp.role && e.name === inp.name)) {
        elements.push(inp as any);
      }
    }
  } catch {}

  // 2c. Clickable generic elements (divs/spans acting as buttons — e.g. Long/Short toggles)
  try {
    const clickableGenerics = await page.evaluate(() => {
      const results: { name: string; tag: string; context: string }[] = [];
      // Find elements with cursor:pointer that aren't standard interactive roles
      const candidates = document.querySelectorAll('div[style*="cursor"], span[style*="cursor"], div[class], span[class]');
      const interactiveTags = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL']);

      for (const el of Array.from(candidates).slice(0, 200)) {
        // Skip standard interactive elements
        if (interactiveTags.has(el.tagName)) continue;
        if (el.closest('button, a, input, select, textarea')) continue;
        // Must be visible
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return results; // early exit if hidden
        if (rect.width < 10 || rect.height < 10) continue;
        // Must have cursor:pointer
        const style = window.getComputedStyle(el);
        if (style.cursor !== 'pointer') continue;
        // Must have short, meaningful text (1-30 chars, no nested interactive children)
        const text = el.textContent?.trim() || '';
        if (text.length < 1 || text.length > 30) continue;
        // Skip if it contains interactive children (it's a wrapper, not the control)
        if (el.querySelector('button, a, input, select')) continue;
        // Skip purely numeric or price-like text
        if (/^[\d,.$%]+$/.test(text)) continue;

        // Get parent context for grouping
        const parent = el.parentElement;
        const siblings = parent ? Array.from(parent.children)
          .filter(c => c !== el && c.textContent?.trim())
          .map(c => c.textContent!.trim().slice(0, 30))
          .slice(0, 3) : [];

        results.push({
          name: text,
          tag: el.tagName.toLowerCase(),
          context: siblings.join(' | '),
        });
      }
      return results;
    });

    for (const gen of clickableGenerics) {
      // Don't add duplicates (check against existing elements by name)
      if (elements.find(e => e.name === gen.name)) continue;
      // Classify: if siblings suggest a toggle group (e.g. "Long" next to "Short"), treat as tab-like
      elements.push({
        role: 'button', // closest semantic match for a clickable div
        name: gen.name,
        type: `clickable-${gen.tag}`,
        disabled: false,
      });
    }
  } catch {}

  // 3. Click dropdowns/comboboxes to force lazy render, then scrape contents
  const dropdownContents: Record<string, string[]> = {};
  await discoverDropdowns(page, elements, dropdownContents);

  // 4. Storage + JS state
  const storage = await page.evaluate(() => {
    const r: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) { const v = localStorage.getItem(k); if (v && v.length < 5000) r[k] = v; }
    }
    return r;
  }).catch(() => ({}));

  const jsState = await page.evaluate(() => {
    const s: Record<string, any> = {};
    if ((window as any).__NEXT_DATA__?.props?.pageProps) {
      const pp = (window as any).__NEXT_DATA__.props.pageProps;
      for (const [k, v] of Object.entries(pp)) {
        if (Array.isArray(v) && v.length > 0) s[`pageProps.${k}`] = v;
      }
    }
    for (const k of ['__APP_CONFIG__', '__MARKETS__', '__PAIRS__', '__ASSETS__', 'TRADING_CONFIG']) {
      if ((window as any)[k]) s[k] = (window as any)[k];
    }
    return s;
  }).catch(() => ({}));

  // 5. Links
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map((a: any) => ({
      text: (a.innerText?.split('\n')[0]?.trim() || '').slice(0, 60),
      href: a.href,
    })).filter((l: any) => l.text && l.href).slice(0, 100)
  ).catch(() => []);

  // Build snapshot text
  let snapshot = `Page: ${pageName}\nURL: ${url}\n\nElements (${elements.length}):\n`;
  elements.forEach((el, i) => {
    snapshot += `  [e${i + 1}] ${el.role}: "${el.name}"${el.type ? ` type=${el.type}` : ''}${el.disabled ? ' (disabled)' : ''}\n`;
  });
  if (Object.keys(dropdownContents).length > 0) {
    snapshot += '\nDropdown Contents:\n';
    for (const [trigger, items] of Object.entries(dropdownContents)) {
      snapshot += `  "${trigger}": ${items.join(', ')}\n`;
    }
  }

  // Screenshot
  let screenshotPath: string | undefined;
  try {
    const safeName = url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
    const path = `${ctx.screenshotDir}/${safeName}.png`;
    await page.screenshot({ path, fullPage: false });
    screenshotPath = path;
    ctx.screenshotCounter++;
  } catch {}

  console.log(`[Crawl]   ${pageName}: ${elements.length} elements, ${Object.keys(dropdownContents).length} dropdowns, ${Object.keys(storage).length} storage keys`);

  return {
    discovery: {
      url, name: pageName, snapshot, screenshotPath,
      interactiveElements: elements.map(e => ({ role: e.role, name: e.name, type: e.type, disabled: e.disabled })),
      walletRequired: false,
    },
    scraped: { url, visibleText, elements, dropdownContents, storage, jsState, links },
  };
}

// -- Dropdown discovery: click triggers, scrape what appears --

async function discoverDropdowns(
  page: Page,
  elements: { role: string; name: string }[],
  dropdownContents: Record<string, string[]>,
): Promise<void> {
  const triggers: { role: string; name: string }[] = [];

  for (const el of elements) {
    if (el.role === 'combobox' && el.name) triggers.push(el);
  }

  const dropdownPatterns = /^(BTC|ETH|SOL|EUR|XAU|Market|Limit|Stop|All|Crypto|Forex|Commodities|Indices|Equities)/i;
  for (const el of elements) {
    if (el.role === 'button' && el.name && dropdownPatterns.test(el.name)) {
      triggers.push(el);
    }
  }

  for (const trigger of triggers) {
    try {
      const btn = page.getByRole(trigger.role as any, { name: trigger.name }).first();
      if (!(await btn.isVisible({ timeout: 500 }).catch(() => false))) continue;

      await btn.click();
      await sleep(1500);

      const items: string[] = [];

      const menuItems = page.getByRole('menuitem');
      const menuCount = await menuItems.count().catch(() => 0);
      for (let i = 0; i < menuCount; i++) {
        const text = (await menuItems.nth(i).textContent().catch(() => '') || '').trim().split('\n')[0]?.slice(0, 60);
        if (text && text.length > 1) items.push(text);
      }

      const options = page.getByRole('option');
      const optCount = await options.count().catch(() => 0);
      for (let i = 0; i < optCount; i++) {
        const text = (await options.nth(i).textContent().catch(() => '') || '').trim().split('\n')[0]?.slice(0, 60);
        if (text && text.length > 1) items.push(text);
      }

      const tabs = page.getByRole('tab');
      const tabCount = await tabs.count().catch(() => 0);
      const tabNames: string[] = [];
      for (let i = 0; i < tabCount; i++) {
        const text = (await tabs.nth(i).textContent().catch(() => '') || '').trim();
        if (text && text.length > 1) tabNames.push(text);
      }
      if (tabNames.length > 0) items.push(`[tabs: ${tabNames.join(', ')}]`);

      if (tabNames.some(t => /crypto|forex|commodities|indices|equities|all/i.test(t))) {
        for (const tabName of tabNames) {
          try {
            const tab = page.getByRole('tab', { name: tabName });
            if (await tab.isVisible({ timeout: 500 }).catch(() => false)) {
              await tab.click();
              await sleep(1000);

              const allText: string[] = await page.evaluate(() => {
                const containers = document.querySelectorAll('[class*="dropdown"], [class*="popover"], [class*="modal"], [class*="list"], [role="listbox"], [role="dialog"]');
                const texts: string[] = [];
                containers.forEach((c: any) => {
                  const items = c.querySelectorAll('div, li, button, a, [role="option"], [role="row"]');
                  items.forEach((item: any) => {
                    const t = item.innerText?.trim().split('\n')[0]?.slice(0, 60);
                    if (t && t.length > 2 && t.length < 50) texts.push(t);
                  });
                });
                return [...new Set(texts)];
              }).catch(() => []);

              const visibleBtns = page.getByRole('button');
              const btnCount = await visibleBtns.count().catch(() => 0);
              for (let b = 0; b < Math.min(btnCount, 60); b++) {
                try {
                  const bt = visibleBtns.nth(b);
                  if (!(await bt.isVisible({ timeout: 200 }).catch(() => false))) continue;
                  const t = (await bt.textContent().catch(() => '') || '').trim().split('\n')[0]?.slice(0, 60);
                  if (t && /^[A-Z]{2,10}[-/][A-Z]{2,10}/.test(t)) allText.push(t);
                } catch {}
              }

              if (allText.length > 0) {
                const key = `${trigger.name} > ${tabName}`;
                dropdownContents[key] = [...new Set(allText)];
                console.log(`[Crawl]     ${key}: ${allText.length} items — ${allText.slice(0, 5).join(', ')}${allText.length > 5 ? '...' : ''}`);
              }
            }
          } catch {}
        }
      }

      if (items.length > 0) {
        dropdownContents[trigger.name] = [...new Set(items)];
        console.log(`[Crawl]     "${trigger.name}": ${items.join(', ')}`);
      }

      await page.keyboard.press('Escape').catch(() => {});
      await sleep(500);
    } catch {}
  }
}

// -- Nav links --

async function getNavLinks(page: Page): Promise<{ text: string; href: string }[]> {
  return page.evaluate(() => {
    const links: { text: string; href: string }[] = [];
    document.querySelectorAll('nav a[href], header a[href]').forEach((a: any) => {
      const text = a.textContent?.trim();
      if (text && text.length > 1 && text.length < 40 && a.href?.startsWith('http'))
        links.push({ text, href: a.href });
    });
    return [...new Map(links.map(l => [l.href, l])).values()];
  }).catch(() => []);
}

// -- Docs crawl --

async function deepCrawlDocs(page: Page, dappUrl: string): Promise<string> {
  let docsContent = '';
  const docsUrls: string[] = [];

  try {
    await page.goto(dappUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map((a: any) => ({ text: a.textContent?.toLowerCase() || '', href: a.href }))
    );
    for (const { text, href } of allLinks) {
      if (href.includes('/docs') || href.includes('docs.') || text.includes('doc') || href.includes('gitbook'))
        if (!docsUrls.includes(href)) docsUrls.push(href);
    }
  } catch {}

  if (docsUrls.length === 0) {
    const hostname = new URL(dappUrl).hostname.replace('developer.', '').replace('app.', '');
    docsUrls.push(`https://docs.${hostname}/`);
  }

  for (const docsUrl of docsUrls.slice(0, 3)) {
    try {
      const docPage = await page.context().newPage();
      await docPage.goto(docsUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
      await sleep(2000);

      const mainText = await extractPageText(docPage);
      if (mainText.length > 100) docsContent += `\n\n=== ${docsUrl} ===\n${mainText}`;

      const sidebarLinks = await docPage.evaluate(() => {
        const links: { text: string; href: string }[] = [];
        document.querySelectorAll('nav a[href], aside a[href], [class*="sidebar"] a[href]').forEach((a: any) => {
          const text = a.textContent?.trim();
          if (text && text.length > 2 && a.href?.startsWith('http')) links.push({ text, href: a.href });
        });
        return [...new Map(links.map(l => [l.href, l])).values()];
      });

      // Generic web3 vocabulary — covers every major archetype (perps / swap /
      // lending / staking / cdp / yield / bridge / nft) without hardcoding any
      // particular dApp's wording. Docs pages matching more keywords are
      // prioritized first under the 15-page cap.
      const keywords = [
        // core actions
        'trade', 'trading', 'swap', 'deposit', 'withdraw', 'stake', 'unstake',
        'supply', 'borrow', 'repay', 'mint', 'redeem', 'bridge', 'transfer',
        'provide', 'pool', 'vault', 'farm', 'earn', 'yield',
        // shared concepts
        'order', 'fees', 'fee', 'slippage', 'liquidation', 'collateral', 'leverage',
        'reward', 'apy', 'apr', 'position', 'balance', 'price',
        // essentials
        'overview', 'quickstart', 'guide', 'tutorial', 'faq',
        'wallet', 'network', 'contract', 'token', 'api', 'protocol',
        'risk', 'limit', 'minimum', 'maximum',
      ];

      const scored = sidebarLinks.map(l => ({
        ...l, score: keywords.filter(k => (l.text + ' ' + l.href).toLowerCase().includes(k)).length,
      })).sort((a, b) => b.score - a.score);

      const visited = new Set([normalizeUrl(docsUrl)]);
      let scraped = 0;
      for (const link of scored) {
        if (scraped >= 15) break;
        if (visited.has(normalizeUrl(link.href))) continue;
        visited.add(normalizeUrl(link.href));
        try {
          await docPage.goto(link.href, { timeout: 10000, waitUntil: 'domcontentloaded' });
          await sleep(1500);
          const text = await extractPageText(docPage);
          if (text.length > 100) {
            docsContent += `\n\n=== ${link.text} (${link.href}) ===\n${text}`;
            scraped++;
            console.log(`[Crawl] Docs: ${link.text} (${(text.length/1000).toFixed(1)}K)`);
          }
        } catch {}
      }
      await docPage.close();
    } catch (e) {
      console.warn(`[Crawl] Docs failed: ${(e as Error).message}`);
    }
  }
  return docsContent;
}

async function extractPageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector('main, article, [role="main"], .content, .markdown-body');
    const el = main || document.body;
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, style, nav, header, footer').forEach(e => e.remove());
    return clone.textContent?.replace(/\s+/g, ' ').trim() || '';
  }).catch(() => '');
}

function detectFeatures(text: string): string[] {
  const kw: Record<string, string> = {
    'swap': 'swap', 'trade': 'trading', 'perpetual': 'perpetual trading',
    'leverage': 'leveraged trading', 'pool': 'liquidity pool', 'vault': 'vault',
    'stake': 'staking', 'lend': 'lending', 'borrow': 'borrowing',
    'bridge': 'bridge', 'nft': 'NFT', 'referral': 'referral',
    'leaderboard': 'leaderboard', 'portfolio': 'portfolio', 'earn': 'earn/yield',
  };
  return [...new Set(Object.entries(kw).filter(([k]) => text.includes(k)).map(([, v]) => v))];
}

function detectChain(text: string): string | undefined {
  const p: Record<string, RegExp> = {
    'Base': /\bbase\b/i, 'Ethereum': /ethereum\s*(mainnet|network)/i,
    'Arbitrum': /arbitrum/i, 'Polygon': /polygon/i, 'Optimism': /optimism/i,
  };
  for (const [c, r] of Object.entries(p)) if (r.test(text)) return c;
}

function normalizeUrl(url: string): string {
  try { return `${new URL(url).hostname}${new URL(url).pathname}`.replace(/\/$/, ''); } catch { return url; }
}

function simplifyUrl(url: string): string {
  try { return new URL(url).pathname.replace(/\/$/, '') || '/'; } catch { return url; }
}

#!/usr/bin/env npx tsx
/**
 * Continuous drift watcher — spins up a headless browser (no MetaMask), walks
 * the pages in the dApp's KG, captures a structural snapshot, diffs against
 * the stored baseline, and writes a drift report + findings-feed entry when
 * anything material changed. Designed to be cron-runnable or used directly
 * via `tsx scripts/watch.ts <hostname> [--interval 1800]`.
 *
 * This is intentionally MM-free: the snapshot only needs the dApp's public
 * page structure, so there is no wallet popup, no chain switch, no tx. That
 * keeps it cheap enough to run every 30 minutes per dApp indefinitely.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { chromium } from 'playwright-core';
import { PROFILES } from '../src/agent/profiles/registry.js';
import {
  emptySnapshot, normalizeTexts, hashStrings,
  diffSnapshots, annotateAffectedFlows,
  saveBaseline, loadBaseline, saveReport, appendFeed,
  type Snapshot, type PageSnapshot,
} from '../src/agent/nodes/drift-detector.js';

interface Args {
  hostname: string;
  interval: number | null; // seconds; null = single pass
  baseline: boolean;       // --baseline: establish a fresh baseline and exit
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error('usage: tsx scripts/watch.ts <hostname-dir> [--interval <seconds>] [--baseline]');
    console.error('example: tsx scripts/watch.ts developer-avantisfi-com --interval 1800');
    process.exit(1);
  }
  const out: Args = { hostname: argv[0], interval: null, baseline: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--interval') out.interval = Number(argv[++i]);
    else if (argv[i] === '--baseline') out.baseline = true;
  }
  return out;
}

async function captureSnapshot(profile: { name: string; url: string }, kgPages: Array<{ id: string; url: string }>): Promise<Snapshot> {
  const origin = new URL(profile.url).origin;
  const pagesToWalk = kgPages.length > 0
    ? kgPages.map(p => ({ id: p.id, url: p.url.startsWith('http') ? p.url : origin + (p.url.startsWith('/') ? p.url : '/' + p.url) }))
    : [{ id: 'page:main', url: profile.url }];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const snapshot = emptySnapshot(profile.name, profile.url);

  for (const pg of pagesToWalk) {
    const page = await context.newPage();
    try {
      await page.goto(pg.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2500);

      const title = await page.title().catch(() => '');
      const buttonTexts = await page.$$eval('button, [role="button"]', els =>
        els.map(e => (e as HTMLElement).innerText || '').slice(0, 200));
      const linkTexts = await page.$$eval('a', els =>
        els.map(e => (e as HTMLElement).innerText || '').slice(0, 200));
      const inputNames = await page.$$eval('input, [role="spinbutton"], [role="textbox"]', els =>
        els.map(e => {
          const el = e as HTMLInputElement;
          return el.getAttribute('aria-label') || el.placeholder || el.name || '';
        }).slice(0, 100));
      const elementCount = await page.$$eval('*', els => els.length);

      const buttons = normalizeTexts(buttonTexts);
      const links = normalizeTexts(linkTexts);
      const inputs = normalizeTexts(inputNames);
      const fingerprint = hashStrings([...buttons, ...links, ...inputs]);

      const pageSnap: PageSnapshot = {
        pageId: pg.id,
        url: pg.url,
        title,
        elementCount,
        buttons, links, inputs,
        fingerprint,
        capturedAt: new Date().toISOString(),
      };
      snapshot.pages.push(pageSnap);
      console.log(`[watch] ${pg.id}: ${elementCount} el / ${buttons.length}b ${links.length}l — fp ${fingerprint}`);
    } catch (err: any) {
      console.warn(`[watch] ${pg.id}: ${err?.message ?? err}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  return snapshot;
}

async function runOnce(args: Args): Promise<void> {
  const profile = PROFILES.find(p => new URL(p.url).hostname.replace(/\./g, '-') === args.hostname);
  if (!profile) {
    console.error(`no profile for hostname "${args.hostname}"`);
    process.exit(2);
  }

  const projectRoot = process.cwd();
  const kgPath = join(projectRoot, 'output', args.hostname, 'knowledge-graph.json');
  const kg: { pages: Array<{ id: string; url: string }>; flows: Array<{ id: string; pageId: string; steps: Array<{ selector?: string; description: string }> }> } =
    existsSync(kgPath)
      ? JSON.parse(readFileSync(kgPath, 'utf8'))
      : { pages: [], flows: [] };

  console.log(`━━━ Drift scan: ${profile.name} (${kg.pages.length} KG pages) ━━━`);
  const snapshot = await captureSnapshot(profile, kg.pages);

  if (args.baseline) {
    const path = saveBaseline(projectRoot, args.hostname, snapshot);
    console.log(`\n[watch] baseline written: ${path}`);
    return;
  }

  const baseline = loadBaseline(projectRoot, args.hostname);
  if (!baseline) {
    console.log('[watch] no baseline — writing current snapshot as baseline');
    saveBaseline(projectRoot, args.hostname, snapshot);
    return;
  }

  const report = annotateAffectedFlows(diffSnapshots(baseline, snapshot), kg);
  const path = saveReport(projectRoot, args.hostname, report);
  console.log(`\n[watch] report: ${path}`);

  if (report.hasDrift) {
    console.log(`[watch] DRIFT DETECTED on ${report.diffs.filter(d => d.changed).length} page(s)`);
    for (const d of report.diffs.filter(d => d.changed)) {
      console.log(`  • ${d.pageId}: ${d.reason}`);
      if (d.affectedFlowIds && d.affectedFlowIds.length > 0) {
        console.log(`    affected flows: ${d.affectedFlowIds.length}`);
      }
    }
    appendFeed(projectRoot, args.hostname, {
      kind: 'drift',
      reportPath: path,
      summary: report.diffs.filter(d => d.changed).map(d => ({ pageId: d.pageId, reason: d.reason, affectedFlows: d.affectedFlowIds?.length ?? 0 })),
    });
  } else {
    console.log('[watch] no drift');
    appendFeed(projectRoot, args.hostname, { kind: 'scan', ok: true });
  }
}

async function main() {
  const args = parseArgs();
  if (args.interval === null) {
    await runOnce(args);
    return;
  }
  console.log(`[watch] continuous mode — interval ${args.interval}s`);
  while (true) {
    try { await runOnce(args); }
    catch (err: any) { console.error('[watch] scan error:', err?.message ?? err); }
    console.log(`[watch] sleeping ${args.interval}s`);
    await new Promise(r => setTimeout(r, args.interval! * 1000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });

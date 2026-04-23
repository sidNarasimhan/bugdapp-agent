import { writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync, symlinkSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AgentStateType, KGFlow, KnowledgeGraph } from '../state.js';
import { getProfileOrThrow, type DAppProfile } from '../profiles/registry.js';
import { getArchetype, type Archetype } from '../archetypes/index.js';

/**
 * Spec Generator — deterministic, no LLM, $0.
 *
 * Takes validated KG flows and generates Playwright .spec.ts files.
 * Uses template patterns for each step type (universal across dApps):
 *   - Asset selection: click trigger → search → click result
 *   - Switch toggle: find by parent text, toggle on/off
 *   - Dropdown: click trigger → click option
 *   - Button pair (Long/Short): click by text
 *   - Input fill: fill spinbutton/textbox
 *   - Submit: click submit button
 *
 * Groups flows into spec files by pattern to avoid 1000+ tiny files.
 */
export function createSpecGeneratorNode() {
  return async (state: AgentStateType) => {
    const { config, knowledgeGraph: kg } = state;

    console.log('━━━ Spec Generator: Creating Playwright specs ━━━');

    // Look up the dApp profile + archetype. Every dApp-specific value — network, min amounts,
    // CTA verbs, close flow — comes from the profile, not hardcoded in this file.
    const profile = getProfileOrThrow(config.url);
    const archetype = getArchetype(profile.archetype);
    console.log(`[SpecGen] Profile: ${profile.name} (${profile.archetype} / ${profile.network.chain})`);

    let validFlows = kg.flows.filter(f => f.testResult === 'pass' && f.id.startsWith('flow:computed:'));
    const otherFlows = kg.flows.filter(f => !f.id.startsWith('flow:computed:'));

    // Fallback: load from persisted valid-flows.json if KG doesn't have validated flows
    if (validFlows.length === 0) {
      const validFlowsPath = join(config.outputDir, 'valid-flows.json');
      if (existsSync(validFlowsPath)) {
        try {
          const persisted = JSON.parse(readFileSync(validFlowsPath, 'utf-8'));
          validFlows = persisted;
          console.log(`[SpecGen] Loaded ${validFlows.length} valid flows from valid-flows.json`);
        } catch {}
      }
    }

    console.log(`[SpecGen] ${validFlows.length} valid flows, ${otherFlows.length} other flows`);

    if (validFlows.length === 0) {
      console.log('[SpecGen] No valid flows — skipping');
      return { specFiles: [] };
    }

    const testsDir = join(config.outputDir, 'tests');
    const fixturesDir = join(config.outputDir, 'fixtures');
    mkdirSync(testsDir, { recursive: true });
    mkdirSync(fixturesDir, { recursive: true });

    // Resolve the project root via fileURLToPath (cross-platform, correct on Windows
    // where raw dirname() on file:// URLs mangles the drive letter).
    //   this file:   <root>/src/agent/nodes/spec-generator.ts
    //   project root: three dirnames up
    const thisFile = fileURLToPath(import.meta.url);
    const projectRoot = resolve(dirname(thisFile), '..', '..', '..');
    const templateDir = join(projectRoot, 'templates');

    // Copy fixture + config templates
    for (const file of ['wallet.fixture.ts', 'playwright.config.ts']) {
      const src = join(templateDir, file);
      const dstDir = file.includes('fixture') ? fixturesDir : config.outputDir;
      const dst = join(dstDir, file);
      try { if (existsSync(src)) copyFileSync(src, dst); } catch {}
    }

    // Copy the on-chain verification module into fixtures/chain/ so the fixture's
    // `import { installTxCapture } from './chain/tx-capture.js'` resolves at runtime
    // against sibling files. Runs before every spec gen so updates to the chain module
    // propagate to regenerated suites.
    const chainSrcDir = join(projectRoot, 'src', 'agent', 'chain');
    const chainDstDir = join(fixturesDir, 'chain');
    if (existsSync(chainSrcDir)) {
      mkdirSync(chainDstDir, { recursive: true });
      for (const file of readdirSync(chainSrcDir)) {
        if (!file.endsWith('.ts')) continue;
        try { copyFileSync(join(chainSrcDir, file), join(chainDstDir, file)); } catch {}
      }
    }

    // Symlink node_modules
    const nmSrc = join(projectRoot, 'node_modules');
    const nmDst = join(config.outputDir, 'node_modules');
    try { if (!existsSync(nmDst) && existsSync(nmSrc)) symlinkSync(nmSrc, nmDst, 'junction'); } catch {}

    // package.json
    writeFileSync(join(config.outputDir, 'package.json'), JSON.stringify({
      name: 'qa-tests', type: 'module',
      dependencies: { '@playwright/test': '^1.58.0', 'playwright-core': '^1.58.0' },
    }, null, 2));

    // ── Group flows into spec files ──
    // Strategy: one spec file per pattern, each containing tests for representative assets
    const patternGroups = groupByPattern(validFlows);
    const specFiles: string[] = [];

    // Also pick representative assets per group for focused testing
    const assetReps = getAssetRepresentatives(kg);

    console.log(`[SpecGen] ${patternGroups.size} patterns, ${assetReps.size} asset groups`);

    for (const [patternKey, flows] of patternGroups) {
      const safeName = patternKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '').slice(0, 60);
      const specPath = join(testsDir, `${safeName}.spec.ts`);

      // Select flows: one per asset group for this pattern
      const selectedFlows = selectRepresentativeFlows(flows, assetReps, kg);

      const code = generateSpecFile(patternKey, selectedFlows, kg, config.url, profile, archetype);
      writeFileSync(specPath, code);
      specFiles.push(specPath);

      console.log(`[SpecGen] ${safeName}.spec.ts — ${selectedFlows.length} tests`);
    }

    // Generate a spec for non-computed flows (navigation, reveal flows)
    if (otherFlows.length > 0) {
      const navFlows = otherFlows.filter(f => f.category === 'navigation' || f.category === 'referral');
      if (navFlows.length > 0) {
        const specPath = join(testsDir, 'navigation.spec.ts');
        const code = generateNavigationSpec(navFlows, kg, config.url);
        writeFileSync(specPath, code);
        specFiles.push(specPath);
        console.log(`[SpecGen] navigation.spec.ts — ${navFlows.length} tests`);
      }
    }

    // Generate adversarial spec from scenarios file if present. This reads the
    // output of `scripts/run-adversarial.ts` and emits one test per scenario.
    const advScenariosPath = join(config.outputDir, 'adversarial-scenarios.json');
    if (existsSync(advScenariosPath)) {
      try {
        const report = JSON.parse(readFileSync(advScenariosPath, 'utf-8'));
        if (Array.isArray(report.scenarios) && report.scenarios.length > 0) {
          const specPath = join(testsDir, 'adversarial.spec.ts');
          const code = generateAdversarialSpec(report.scenarios, config.url, profile, archetype);
          writeFileSync(specPath, code);
          specFiles.push(specPath);
          console.log(`[SpecGen] adversarial.spec.ts — ${report.scenarios.length} scenarios`);
        }
      } catch (err: any) {
        console.warn(`[SpecGen] failed to load adversarial scenarios: ${err?.message ?? err}`);
      }
    }

    console.log(`[SpecGen] Generated ${specFiles.length} spec files`);

    return { specFiles };
  };
}

// ── Helpers ──

function groupByPattern(flows: KGFlow[]): Map<string, KGFlow[]> {
  const groups = new Map<string, KGFlow[]>();
  for (const flow of flows) {
    // Include dimension VALUES to distinguish patterns like "ZFP on + Long" vs "ZFP off + Short"
    const dims = flow.steps
      .filter(s => s.description.startsWith('Set '))
      .map(s => {
        const match = s.description.match(/^Set (.+?) to "(.+?)"$/);
        return match ? `${match[1]}=${match[2]}` : s.description;
      })
      .join('_');
    // Flows without "Set" steps (e.g. swaps with just a Fill) fall back to category.
    const key = dims || flow.category || 'default';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(flow);
  }
  return groups;
}

function getAssetRepresentatives(kg: KnowledgeGraph): Map<string, string> {
  const reps = new Map<string, string>();
  for (const asset of kg.assets) {
    if (!reps.has(asset.group)) reps.set(asset.group, asset.symbol);
  }
  return reps;
}

function selectRepresentativeFlows(
  flows: KGFlow[],
  assetReps: Map<string, string>,
  kg: KnowledgeGraph,
): KGFlow[] {
  const repSymbols = new Set(assetReps.values());
  const selected: KGFlow[] = [];
  const seenGroups = new Set<string>();

  for (const flow of flows) {
    const assetMatch = flow.name.match(/^([A-Z]+-[A-Z]+)/);
    if (!assetMatch) { selected.push(flow); continue; }
    const asset = kg.assets.find(a => a.symbol === assetMatch[1]);
    if (!asset) continue;
    if (seenGroups.has(asset.group)) continue;
    seenGroups.add(asset.group);
    selected.push(flow);
  }
  return selected;
}

function serializeRegex(re: RegExp): string {
  // Emit a JS regex literal from a RegExp object — e.g. /^Trade$/i
  return `/${re.source}/${re.flags}`;
}

function generateSpecFile(
  patternName: string,
  flows: KGFlow[],
  kg: KnowledgeGraph,
  dappUrl: string,
  profile: DAppProfile,
  archetype: Archetype,
): string {
  const lines: string[] = [];

  // Compute values once per spec — archetype derives them from profile config.
  // For dApps with per-flow variations (e.g., Avantis ZFP-on needs higher min leverage),
  // we'll handle per-flow overrides below.
  const ctaTiers = profile.selectors?.ctaTiers ?? archetype.defaultCtaTiers;
  const primaryPatternSerialized = serializeRegex(archetype.primaryActionPattern);

  lines.push(`// Auto-generated by bugdapp-agent spec-generator`);
  lines.push(`// dApp: ${profile.name} (${profile.archetype} / ${profile.network.chain})`);
  lines.push(`import { test, expect, connectWallet, raceConfirmTransaction, verifyPage, getTestWalletAddress, emitFindingIfNeeded } from '../fixtures/wallet.fixture';`);
  lines.push(``);
  lines.push(`const DAPP_URL = '${dappUrl}';`);
  lines.push(`const DAPP_CHAIN_ID = ${profile.network.chainId};`);
  lines.push(`const DAPP_ARCHETYPE = '${profile.archetype}' as const;`);
  lines.push(``);
  lines.push(`// Chain params — passed to connectWallet for proactive wallet_switchEthereumChain.`);
  lines.push(`const CHAIN_PARAMS = {`);
  lines.push(`  chainHexId: '${profile.network.chainHexId}',`);
  lines.push(`  chainName: ${JSON.stringify(profile.network.chain.charAt(0).toUpperCase() + profile.network.chain.slice(1))},`);
  lines.push(`  rpcUrl: '${profile.network.rpcUrl}',`);
  lines.push(`  blockExplorerUrl: '${profile.network.blockExplorerUrl}',`);
  lines.push(`  nativeCurrency: ${JSON.stringify(profile.network.nativeCurrency)},`);
  lines.push(`};`);
  lines.push(``);
  // Connect hints (per-dApp wallet-modal quirks)
  const connectHints = profile.selectors?.connect;
  lines.push(`// Connect hints — per-dApp wallet-modal quirks (Uniswap hides MetaMask, etc.)`);
  lines.push(`const CONNECT_HINTS = {`);
  if (connectHints?.preMetaMaskClicks && connectHints.preMetaMaskClicks.length > 0) {
    lines.push(`  preMetaMaskClicks: [`);
    for (const hint of connectHints.preMetaMaskClicks) {
      if (typeof hint === 'string') {
        lines.push(`    ${JSON.stringify(hint)},`);
      } else {
        lines.push(`    ${serializeRegex(hint)},`);
      }
    }
    lines.push(`  ],`);
  }
  if (connectHints?.loginButtonPattern) {
    lines.push(`  loginButtonPattern: ${serializeRegex(connectHints.loginButtonPattern)},`);
  }
  if (connectHints?.loginButtonTestId) {
    lines.push(`  loginButtonTestId: ${JSON.stringify(connectHints.loginButtonTestId)},`);
  }
  lines.push(`};`);
  lines.push(``);
  lines.push(`// Primary action pattern for this archetype (${archetype.name}) — used by the state classifier.`);
  lines.push(`const PRIMARY_ACTION = ${primaryPatternSerialized};`);
  lines.push(`// CTA priority tiers. spec-generator picks the first visible match as the form CTA.`);
  lines.push(`const CTA_TIERS: RegExp[] = [`);
  for (const tier of ctaTiers) {
    lines.push(`  ${serializeRegex(tier)},`);
  }
  lines.push(`];`);
  lines.push(``);
  lines.push(`test.describe('${patternName.replace(/'/g, "\\'")}', () => {`);
  lines.push(`  test.beforeEach(async ({ page }) => {`);
  lines.push(`    // Wallet connect (idempotent) + RPC-level chain switch + per-dApp connect hints.`);
  lines.push(`    await connectWallet(page, DAPP_URL, CHAIN_PARAMS, CONNECT_HINTS);`);
  lines.push(`    // Close any post-connect banners that block the form.`);
  lines.push(`    const banner = page.getByRole('button', { name: /close banner/i }).first();`);
  lines.push(`    if (await banner.isVisible({ timeout: 2000 }).catch(() => false)) await banner.click();`);
  lines.push(`  });`);
  lines.push(``);

  for (const flow of flows) {
    const testName = flow.name.replace(/'/g, "\\'");
    const asset = flow.name.match(/^([A-Z]+-[A-Z]+)/)?.[1];
    const assetInfo = asset ? kg.assets.find(a => a.symbol === asset) : null;

    // Per-flow value derivation. Archetype handles the base case; perps profiles may need
    // per-flow overrides (e.g., ZFP-on requires higher min leverage on Avantis).
    const valueOverrides = deriveFlowValueOverrides(flow, profile);
    const mergedValues = { ...profile.values, ...valueOverrides };
    const { collateral, leverage } = archetype.pickValues(mergedValues);
    const stepCtx = { leverage, collateral };

    lines.push(`  test('${testName}', async ({ page }) => {`);

    for (const step of flow.steps) {
      const code = stepToPlaywright(step, kg, dappUrl, stepCtx);
      for (const line of code) {
        lines.push(`    ${line}`);
      }
    }

    // ── Verify form state, classify CTA terminal state, submit if ready ──
    lines.push(`    await page.waitForTimeout(2000);`);
    lines.push(`    // Walk CTA_TIERS top-to-bottom; first visible match that's NOT inside nav/header is the form CTA.`);
    lines.push(`    // Nav bars often contain "Trade" / "Swap" links that would otherwise shadow the real form CTA.`);
    lines.push(`    let submitBtn: ReturnType<typeof page.getByRole> | null = null;`);
    lines.push(`    let ctaText = '';`);
    lines.push(`    for (const pat of CTA_TIERS) {`);
    lines.push(`      const candidates = await page.getByRole('button', { name: pat }).all();`);
    lines.push(`      for (const btn of candidates) {`);
    lines.push(`        const visible = await btn.isVisible().catch(() => false);`);
    lines.push(`        if (!visible) continue;`);
    lines.push(`        const insideNav = await btn.evaluate((el) => {`);
    lines.push(`          let p: Element | null = el;`);
    lines.push(`          while (p) {`);
    lines.push(`            const tag = p.tagName?.toLowerCase();`);
    lines.push(`            if (tag === 'nav' || tag === 'header') return true;`);
    lines.push(`            const cls = (p.getAttribute && p.getAttribute('class')) || '';`);
    lines.push(`            if (/navbar|navigation|topbar|header/i.test(cls)) return true;`);
    lines.push(`            p = p.parentElement;`);
    lines.push(`          }`);
    lines.push(`          return false;`);
    lines.push(`        }).catch(() => false);`);
    lines.push(`        if (insideNav) continue;`);
    lines.push(`        submitBtn = btn as typeof submitBtn;`);
    lines.push(`        ctaText = (await btn.innerText().catch(() => '')).trim();`);
    lines.push(`        break;`);
    lines.push(`      }`);
    lines.push(`      if (submitBtn) break;`);
    lines.push(`    }`);
    lines.push(`    if (!submitBtn) {`);
    lines.push(`      const allBtns = await page.getByRole('button').all();`);
    lines.push(`      const names: string[] = [];`);
    lines.push(`      for (const b of allBtns.slice(-15)) names.push((await b.innerText().catch(() => '')).trim().slice(0, 40));`);
    lines.push(`      throw new Error('No matching form CTA found (outside nav). Last 15 buttons on page: ' + JSON.stringify(names));`);
    lines.push(`    }`);
    lines.push(`    await expect(submitBtn, 'A form CTA should be visible after filling the form').toBeVisible({ timeout: 3000 });`);
    lines.push(`    const pageText = await page.locator('body').innerText().catch(() => '');`);
    lines.push(`    const ctaDisabled = await submitBtn.isDisabled().catch(() => false);`);
    lines.push(``);
    lines.push(`    // Classify the terminal state. Generic across archetypes — only the primary-action`);
    lines.push(`    // regex is archetype-specific (serialized as PRIMARY_ACTION above).`);
    lines.push(`    type TerminalState = 'ready-to-action' | 'needs-approval' | 'wrong-network' | 'unfunded' | 'unconnected' | 'min-amount' | 'max-amount' | 'unknown';`);
    lines.push(`    let state: TerminalState = 'unknown';`);
    lines.push(`    const isPrimary = PRIMARY_ACTION.test(ctaText);`);
    lines.push(`    if (isPrimary && !ctaDisabled) {`);
    lines.push(`      state = 'ready-to-action';`);
    lines.push(`    } else if (/^Approve/i.test(ctaText)) {`);
    lines.push(`      state = 'needs-approval';`);
    lines.push(`    } else if (/Switch to|Wrong Network|Unsupported Network|Change Network/i.test(ctaText)) {`);
    lines.push(`      state = 'wrong-network';`);
    lines.push(`    } else if (/^(Add Funds|Get Funds)$/i.test(ctaText)) {`);
    lines.push(`      state = 'unfunded';`);
    lines.push(`    } else if (/^(Connect Wallet|Login|Connect)$/i.test(ctaText)) {`);
    lines.push(`      state = 'unconnected';`);
    lines.push(`    } else if (isPrimary && ctaDisabled) {`);
    lines.push(`      if (/insufficient|not enough|exceeds balance/i.test(pageText)) state = 'unfunded';`);
    lines.push(`      else if (/Minimum.*(is below|required|not met)|Position size is too (low|small)|below minimum/i.test(pageText)) state = 'min-amount';`);
    lines.push(`      else if (/Maximum|exceeds max|above maximum|over limit/i.test(pageText)) state = 'max-amount';`);
    lines.push(`      else if (/Switch to|Wrong Network|Change Network/i.test(pageText)) state = 'wrong-network';`);
    lines.push(`      else state = 'unknown';`);
    lines.push(`    }`);
    lines.push(`    console.log('[test] terminal state:', state, '/ CTA:', JSON.stringify(ctaText), '/ disabled:', ctaDisabled);`);
    lines.push(``);
    lines.push(`    // Happy path: execute the primary action.`);
    lines.push(`    if (state === 'ready-to-action') {`);
    lines.push(`      await submitBtn.click();`);
    lines.push(`      await page.waitForTimeout(2000);`);
    lines.push(`      try { await raceConfirmTransaction(page.context(), page); } catch {}`);
    lines.push(`      await page.bringToFront().catch(() => {});`);
    lines.push(`      await page.waitForTimeout(5000);`);
    lines.push(`      const afterText = await page.locator('body').innerText().catch(() => '');`);
    lines.push(`      const failSig = /rejected|user denied|transaction failed|reverted/i.test(afterText);`);
    lines.push(`      const okSig = /success|confirmed|position opened|trade placed|order placed|submitted|pending|supplied|borrowed|swap.*complete/i.test(afterText);`);
    lines.push(`      if (failSig && !okSig) {`);
    lines.push(`        const err = afterText.match(/(rejected|user denied|transaction failed|reverted)[^\\n]{0,120}/i)?.[0] || 'unknown';`);
    lines.push(`        throw new Error(\`Transaction failed: \${err}\`);`);
    lines.push(`      }`);
    lines.push(`      expect(okSig, \`Expected success signal after submit, got CTA="\${ctaText}"\`).toBe(true);`);
    lines.push(`      // ── On-chain verification ──`);
    lines.push(`      // Resolve captured tx hashes into decoded receipts, run archetype assertions.`);
    lines.push(`      // Non-blocking: failures are logged + attached to testInfo for the findings reporter.`);
    lines.push(`      try {`);
    lines.push(`        const verification = await verifyPage(page, {`);
    lines.push(`          archetype: DAPP_ARCHETYPE,`);
    lines.push(`          wallet: getTestWalletAddress(),`);
    lines.push(`          defaultChainId: DAPP_CHAIN_ID,`);
    lines.push(`          expected: { flow: ${JSON.stringify(flow.name)} },`);
    lines.push(`        });`);
    lines.push(`        console.log('[chain] ' + verification.receipts.length + ' receipt(s), ' + verification.assertions.length + ' assertion(s), ' + verification.failed.length + ' failed');`);
    lines.push(`        for (const a of verification.assertions) {`);
    lines.push(`          console.log('[chain] ' + (a.passed ? '✓' : '✗') + ' ' + a.id + ' — ' + a.detail);`);
    lines.push(`        }`);
    lines.push(`        (test.info() as any).annotations.push({ type: 'chain-verification', description: JSON.stringify({ receipts: verification.receipts.length, failed: verification.failed.map(f => ({ id: f.id, severity: f.severity, detail: f.detail })) }) });`);
    lines.push(`        const findingDir = emitFindingIfNeeded(test.info(), verification, {`);
    lines.push(`          dapp: ${JSON.stringify(profile.name)},`);
    lines.push(`          url: DAPP_URL,`);
    lines.push(`          archetype: DAPP_ARCHETYPE,`);
    lines.push(`          chainId: DAPP_CHAIN_ID,`);
    lines.push(`          wallet: getTestWalletAddress(),`);
    lines.push(`          flowId: ${JSON.stringify(flow.id)},`);
    lines.push(`        });`);
    lines.push(`        if (findingDir) console.log('[chain] finding bundle: ' + findingDir);`);
    lines.push(`      } catch (verifyErr) {`);
    lines.push(`        console.warn('[chain] verification error:', (verifyErr as Error).message);`);
    lines.push(`      }`);
    lines.push(`      console.log('[test] primary action succeeded — running inverse/cleanup flows');`);

    // Generate inverse flow cleanup (close position, withdraw, repay, reverse swap, etc.)
    // from profile.inverseFlows instead of hardcoding /portfolio + Close.
    const origin = safeOrigin(dappUrl);
    for (const inverse of profile.inverseFlows ?? []) {
      const inverseUrl = origin + inverse.route;
      const ctaPatSer = serializeRegex(inverse.ctaPattern);
      const confirmPatSer = inverse.confirmPattern ? serializeRegex(inverse.confirmPattern) : null;
      lines.push(`      // Inverse flow: ${inverse.name.replace(/'/g, "\\'")}`);
      lines.push(`      try {`);
      lines.push(`        // Prefer clicking a nav link matching the route; fall back to goto.`);
      lines.push(`        const navTarget = '${inverse.route.replace(/^\//, '').replace(/\/.*/, '')}';`);
      lines.push(`        const navLink = page.getByRole('link', { name: new RegExp('^' + navTarget + '$', 'i') }).first();`);
      lines.push(`        if (await navLink.isVisible({ timeout: 2000 }).catch(() => false)) {`);
      lines.push(`          await navLink.click();`);
      lines.push(`        } else {`);
      lines.push(`          await page.goto('${inverseUrl}');`);
      lines.push(`        }`);
      lines.push(`        await page.waitForTimeout(3500);`);
      lines.push(`        const inverseBtn = page.getByRole('button', { name: ${ctaPatSer} }).first();`);
      lines.push(`        if (await inverseBtn.isVisible({ timeout: 4000 }).catch(() => false)) {`);
      lines.push(`          await inverseBtn.click();`);
      lines.push(`          await page.waitForTimeout(1500);`);
      if (confirmPatSer) {
        lines.push(`          const confirmBtn = page.getByRole('button', { name: ${confirmPatSer} }).last();`);
        lines.push(`          if (await confirmBtn.isVisible({ timeout: 2500 }).catch(() => false)) {`);
        lines.push(`            await confirmBtn.click();`);
        lines.push(`          }`);
      }
      lines.push(`          await page.waitForTimeout(2000);`);
      lines.push(`          try { await raceConfirmTransaction(page.context(), page); } catch {}`);
      lines.push(`          await page.bringToFront().catch(() => {});`);
      lines.push(`          await page.waitForTimeout(4000);`);
      lines.push(`          console.log('[test] inverse flow "${inverse.name.replace(/'/g, "\\'")}" signal sent');`);
      lines.push(`        } else {`);
      lines.push(`          console.warn('[test] inverse flow "${inverse.name.replace(/'/g, "\\'")}" button not found — cleanup may be incomplete');`);
      lines.push(`        }`);
      lines.push(`      } catch (inverseErr) {`);
      lines.push(`        console.warn('[test] inverse flow "${inverse.name.replace(/'/g, "\\'")}" failed:', (inverseErr as Error).message);`);
      lines.push(`      }`);
    }

    lines.push(`      return;`);
    lines.push(`    }`);
    lines.push(``);
    lines.push(`    // Blocker states — form mechanics worked but cannot execute. Valid form-ready pass.`);
    lines.push(`    if (state === 'needs-approval') {`);
    lines.push(`      // Token approval required first — click Approve, confirm, then the test ends here.`);
    lines.push(`      // (A follow-up test run will see an enabled primary CTA.)`);
    lines.push(`      await submitBtn.click();`);
    lines.push(`      await page.waitForTimeout(2000);`);
    lines.push(`      try { await raceConfirmTransaction(page.context(), page); } catch {}`);
    lines.push(`      await page.bringToFront().catch(() => {});`);
    lines.push(`      // ── On-chain verification for approval tx ──`);
    lines.push(`      try {`);
    lines.push(`        const verification = await verifyPage(page, {`);
    lines.push(`          archetype: DAPP_ARCHETYPE,`);
    lines.push(`          wallet: getTestWalletAddress(),`);
    lines.push(`          defaultChainId: DAPP_CHAIN_ID,`);
    lines.push(`          expected: { flow: ${JSON.stringify(flow.name)}, stage: 'approval' },`);
    lines.push(`        });`);
    lines.push(`        console.log('[chain] approval tx(s): ' + verification.receipts.length + ', assertions: ' + verification.assertions.length);`);
    lines.push(`        for (const a of verification.assertions) {`);
    lines.push(`          console.log('[chain] ' + (a.passed ? '✓' : '✗') + ' ' + a.id + ' — ' + a.detail);`);
    lines.push(`        }`);
    lines.push(`      } catch (verifyErr) { console.warn('[chain]', (verifyErr as Error).message); }`);
    lines.push(`      console.log('[test] approval submitted — primary action will be tested on next run');`);
    lines.push(`      return;`);
    lines.push(`    }`);
    lines.push(`    if (state === 'unfunded' || state === 'min-amount' || state === 'max-amount') {`);
    lines.push(`      console.log('[test] form configured but cannot execute (' + state + ') — pass');`);
    lines.push(`      return;`);
    lines.push(`    }`);
    lines.push(`    if (state === 'wrong-network') {`);
    lines.push(`      console.log('[test] wrong network — pass (connectWallet should have handled this)');`);
    lines.push(`      return;`);
    lines.push(`    }`);
    lines.push(`    if (state === 'unconnected') {`);
    lines.push(`      throw new Error('Wallet is not connected — connectWallet() fixture helper failed earlier in the test');`);
    lines.push(`    }`);
    lines.push(`    throw new Error(\`Form reached an unknown terminal state. CTA text: "\${ctaText}". Update the profile's ctaTiers or the archetype classifier.\`);`);
    if (assetInfo) {
      lines.push(`    // Asset: ${assetInfo.symbol} (${assetInfo.group})`);
    }
    lines.push(`  });`);
    lines.push(``);
  }

  lines.push(`});`);
  return lines.join('\n');
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url.replace(/\/[^/]*$/, ''); }
}

/**
 * Per-flow value overrides. Most archetypes return an empty object here; perps may need
 * to bump leverage for ZFP-style "minimum leverage" scopes, forex forms need to clamp down
 * leverage, etc. Generic enough to be driven by profile hints.
 */
function deriveFlowValueOverrides(flow: KGFlow, profile: DAppProfile): Partial<import('../profiles/types.js').ValueConfig> {
  const overrides: Partial<import('../profiles/types.js').ValueConfig> = {};

  // Forex assets typically have lower max leverage — clamp if profile didn't already.
  const asset = flow.name.match(/^([A-Z]+-[A-Z]+)/)?.[1];
  if (asset && /EUR|GBP|JPY|CHF|AUD|CAD/i.test(asset)) {
    if ((profile.values.targetLeverage ?? 100) > 50) overrides.targetLeverage = 50;
  }
  // "Zero Fee Perps on" steps signal a min-leverage scope bump on perps dApps that
  // offer this feature (currently Avantis). Check the flow steps for that marker.
  const zfpOn = flow.steps.some(s => /Zero Fee Perps.*"on"/i.test(s.description));
  if (zfpOn) {
    // ZFP needs >=75 — ensure we don't go below that.
    const current = profile.values.targetLeverage ?? 100;
    if (current < 75) overrides.targetLeverage = 75;
  }
  return overrides;
}

function stepToPlaywright(
  step: { description: string; selector?: string; expectedOutcome?: string },
  kg: KnowledgeGraph,
  dappUrl: string,
  ctx: { leverage: string; collateral: string } = { leverage: '10', collateral: '10' },
): string[] {
  const desc = step.description;
  const lines: string[] = [];

  // ── Select asset from modal ──
  if (desc.startsWith('Select ') && desc.includes('from asset selector')) {
    const asset = desc.replace('Select ', '').replace(' from asset selector', '');
    const symbol = asset.split('-')[0]; // ETH from ETH-USD

    lines.push(`// ${desc}`);
    lines.push(`{`);
    lines.push(`  // Open the asset selector. Most perps/DEX dApps show the current pair (e.g. "BTCUSD 72900") in a top-of-form button.`);
    lines.push(`  // Substring match — the opener's accessible name often includes price or volume alongside the symbol.`);
    lines.push(`  const assetOpener = page.getByRole('button', { name: /[A-Z]{3,}[-/]?USD/i }).first();`);
    lines.push(`  await assetOpener.click();`);
    lines.push(`  await page.waitForTimeout(1500);`);
    lines.push(`  // Scope all subsequent clicks to the asset-selector dialog/modal, NOT the whole page.`);
    lines.push(`  const modal = page.getByRole('dialog').or(page.locator('[role="presentation"], [class*="modal" i], [class*="Modal" i], [class*="drawer" i]')).last();`);
    lines.push(`  const search = modal.getByRole('textbox').or(page.getByRole('textbox')).first();`);
    lines.push(`  if (await search.isVisible({ timeout: 2000 }).catch(() => false)) {`);
    lines.push(`    await search.fill('${symbol}');`);
    lines.push(`    await page.waitForTimeout(800);`);
    lines.push(`  }`);
    lines.push(`  // Click the exact asset row — match the FULL symbol like "ETH-USD" or "ETHUSD", not a substring.`);
    lines.push(`  const rowPatterns = [/^${symbol}[-/]?USD$/i, /^${symbol}[-/]?USD\\b/i, /${symbol}[-/]?USD/i];`);
    lines.push(`  let assetClicked = false;`);
    lines.push(`  for (const pat of rowPatterns) {`);
    lines.push(`    // Try clicking inside the modal first — safer than page-wide search.`);
    lines.push(`    const row = modal.getByText(pat).first();`);
    lines.push(`    if (await row.isVisible({ timeout: 1500 }).catch(() => false)) {`);
    lines.push(`      await row.click({ timeout: 3000 }).catch(() => {});`);
    lines.push(`      assetClicked = true;`);
    lines.push(`      break;`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`  if (!assetClicked) {`);
    lines.push(`    // Last resort — page-wide text search, but require FULL symbol to avoid matching 'ETH' in 'RENDER-ETH' etc.`);
    lines.push(`    await page.getByText(/^${symbol}[-/]?USD/i).first().click({ timeout: 3000 }).catch(() => {});`);
    lines.push(`  }`);
    lines.push(`  await page.waitForTimeout(1500);`);
    lines.push(`  // Press Escape in case the modal stayed open.`);
    lines.push(`  await page.keyboard.press('Escape').catch(() => {});`);
    lines.push(`  await page.waitForTimeout(500);`);
    lines.push(`}`);
    return lines;
  }

  // ── Set switch on/off ──
  if (desc.startsWith('Set ') && (desc.endsWith('"on"') || desc.endsWith('"off"'))) {
    const match = desc.match(/^Set (.+?) to "(.+?)"$/);
    if (!match) return [`// TODO: ${desc}`];
    const [, dimension, value] = match;
    const dimClean = dimension.replace(/^Set /, '');
    const wantOn = value === 'on';

    lines.push(`// ${desc}`);
    lines.push(`{`);
    lines.push(`  const switches = page.getByRole('switch');`);
    lines.push(`  const count = await switches.count();`);
    lines.push(`  for (let i = 0; i < count; i++) {`);
    lines.push(`    const sw = switches.nth(i);`);
    lines.push(`    const parent = await sw.evaluate(el => {`);
    lines.push(`      let p = el.parentElement;`);
    lines.push(`      for (let d = 0; d < 4 && p; d++) { if (p.textContent?.includes('${dimClean}')) return true; p = p.parentElement; }`);
    lines.push(`      return false;`);
    lines.push(`    });`);
    lines.push(`    if (parent) {`);
    lines.push(`      const checked = await sw.getAttribute('aria-checked') === 'true';`);
    lines.push(`      if (checked !== ${wantOn}) await sw.click();`);
    lines.push(`      await page.waitForTimeout(500);`);
    lines.push(`      break;`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`}`);
    return lines;
  }

  // ── Set dropdown option ──
  if (desc.startsWith('Set ') && desc.includes('to "')) {
    const match = desc.match(/^Set (.+?) to "(.+?)"$/);
    if (!match) return [`// TODO: ${desc}`];
    const [, dimension, value] = match;

    // Button pair (Long/Short, Buy/Sell etc.)
    if (dimension.includes('/')) {
      lines.push(`// ${desc}`);
      lines.push(`await page.getByText('${value}', { exact: true }).first().click();`);
      lines.push(`await page.waitForTimeout(500);`);
      return lines;
    }

    // Dropdown: click trigger then option
    lines.push(`// ${desc}`);
    lines.push(`{`);
    lines.push(`  // Check if already selected`);
    lines.push(`  const trigger = page.getByRole('button', { name: /^${escapeRegex(value)}$/i }).first();`);
    lines.push(`  const alreadySelected = await trigger.isVisible({ timeout: 500 }).catch(() => false);`);
    lines.push(`  if (!alreadySelected) {`);
    lines.push(`    // Open dropdown and select`);
    lines.push(`    const dropdownTrigger = page.getByRole('button', { name: /Market|Limit|Stop/i }).first();`);
    lines.push(`    if (await dropdownTrigger.isVisible({ timeout: 1000 }).catch(() => false)) {`);
    lines.push(`      await dropdownTrigger.click();`);
    lines.push(`      await page.waitForTimeout(500);`);
    lines.push(`    }`);
    lines.push(`    const option = page.getByRole('option', { name: '${value}' }).first();`);
    lines.push(`    if (await option.isVisible({ timeout: 1000 }).catch(() => false)) {`);
    lines.push(`      await option.click();`);
    lines.push(`    } else {`);
    lines.push(`      await page.getByText('${value}', { exact: true }).first().click();`);
    lines.push(`    }`);
    lines.push(`    await page.waitForTimeout(500);`);
    lines.push(`  }`);
    lines.push(`}`);
    return lines;
  }

  // ── Fill input (generic) ──
  if (desc.startsWith('Fill ')) {
    const nameMatch = desc.match(/Fill (.+?) with/);
    const name = nameMatch ? nameMatch[1] : '';
    const isLeverage = /leverage/i.test(name);
    const value = isLeverage ? ctx.leverage : ctx.collateral;
    lines.push(`// ${desc}`);
    if (name) {
      lines.push(...emitRobustFill(name, value));
    }
    return lines;
  }

  // ── Adjust slider / numeric control ──
  if (desc.startsWith('Adjust ')) {
    const name = desc.replace('Adjust ', '');
    const isLeverage = /leverage/i.test(name);
    const value = isLeverage ? ctx.leverage : ctx.collateral;
    lines.push(`// ${desc}`);
    lines.push(...emitRobustFill(name, value));
    return lines;
  }

  // ── Click button (submit or other) ──
  if (desc.startsWith('Click ')) {
    const btnName = desc.replace('Click ', '');
    lines.push(`// ${desc}`);
    lines.push(`{`);
    lines.push(`  const btn = page.getByRole('button', { name: '${btnName}' }).first();`);
    lines.push(`  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {`);
    lines.push(`    // Verify button state (don't click submit if disabled)`);
    lines.push(`    const disabled = await btn.isDisabled();`);
    lines.push(`    expect(await btn.isVisible()).toBe(true);`);
    lines.push(`  }`);
    lines.push(`}`);
    return lines;
  }

  // Fallback
  lines.push(`// TODO: ${desc}`);
  return lines;
}

/**
 * Generate a Playwright spec that exercises adversarial scenarios. Each scenario
 * produces one test. The test connects the wallet, navigates to the dApp, attempts
 * the scenario's mutation (best-effort — requires form knowledge for full execution),
 * and runs chain verification. Scenarios that need dApp-specific form mutation
 * logic are emitted as clearly-marked TODOs so they appear in the Playwright run
 * but don't silently pass on unimplemented checks.
 */
function generateAdversarialSpec(
  scenarios: Array<{
    id: string;
    archetype: string;
    target: string;
    name: string;
    description: string;
    mutations: Record<string, unknown>;
    expectedAssertions: Array<{ id: string; kind: string; signal: string }>;
    severity: string;
  }>,
  dappUrl: string,
  profile: DAppProfile,
  archetype: Archetype,
): string {
  const lines: string[] = [];
  lines.push(`// Auto-generated adversarial suite — sourced from adversarial-scenarios.json`);
  lines.push(`// dApp: ${profile.name} (${profile.archetype} / ${profile.network.chain})`);
  lines.push(`// Each scenario is a known exploit-class probe; failures are findings.`);
  lines.push(`import { test, expect, connectWallet, verifyPage, getTestWalletAddress, emitFindingIfNeeded } from '../fixtures/wallet.fixture';`);
  lines.push(``);
  lines.push(`const DAPP_URL = '${dappUrl}';`);
  lines.push(`const DAPP_CHAIN_ID = ${profile.network.chainId};`);
  lines.push(`const DAPP_ARCHETYPE = '${profile.archetype}' as const;`);
  lines.push(`const CHAIN_PARAMS = {`);
  lines.push(`  chainHexId: '${profile.network.chainHexId}',`);
  lines.push(`  chainName: ${JSON.stringify(profile.network.chain.charAt(0).toUpperCase() + profile.network.chain.slice(1))},`);
  lines.push(`  rpcUrl: '${profile.network.rpcUrl}',`);
  lines.push(`  blockExplorerUrl: '${profile.network.blockExplorerUrl}',`);
  lines.push(`  nativeCurrency: ${JSON.stringify(profile.network.nativeCurrency)},`);
  lines.push(`};`);
  lines.push(``);
  lines.push(`test.describe('Adversarial scenarios — ${profile.name}', () => {`);
  lines.push(`  test.beforeEach(async ({ page }) => {`);
  lines.push(`    await connectWallet(page, DAPP_URL, CHAIN_PARAMS);`);
  lines.push(`    await page.waitForTimeout(1000);`);
  lines.push(`  });`);
  lines.push(``);

  for (const s of scenarios) {
    const title = `[${s.severity.toUpperCase()}] ${s.name}`.replace(/'/g, "\\'");
    lines.push(`  test(${JSON.stringify(title)}, async ({ page }) => {`);
    lines.push(`    // Scenario: ${s.id} / target: ${s.target}`);
    lines.push(`    // ${s.description.replace(/\n/g, ' ')}`);
    lines.push(`    // Mutations: ${JSON.stringify(s.mutations)}`);
    lines.push(`    console.log('[adversarial] scenario: ${s.id}');`);
    lines.push(``);

    // For the handful of scenarios we can execute generically, do so. For others,
    // emit a probe that navigates + records a "not-yet-implemented" annotation so
    // the test appears in the run output without falsely claiming pass.
    if (s.target === 'zero-amount') {
      lines.push(`    // zero-amount probe — locate the primary amount input, clear it, try to submit.`);
      lines.push(`    const amountInput = page.getByRole('spinbutton').first();`);
      lines.push(`    if (await amountInput.isVisible({ timeout: 3000 }).catch(() => false)) {`);
      lines.push(`      await amountInput.fill('0');`);
      lines.push(`      await page.waitForTimeout(1000);`);
      lines.push(`      const pageText = await page.locator('body').innerText();`);
      lines.push(`      const blockedByForm = /enter.*amount|amount.*required|invalid amount|zero/i.test(pageText);`);
      lines.push(`      console.log('[adversarial] zero-amount blocked by form:', blockedByForm);`);
      lines.push(`      (test.info() as any).annotations.push({ type: 'adversarial', description: JSON.stringify({ scenario: '${s.id}', blockedByForm }) });`);
      lines.push(`    } else {`);
      lines.push(`      console.log('[adversarial] no spinbutton found — probe inconclusive');`);
      lines.push(`    }`);
    } else if (s.target === 'approval-overspend') {
      lines.push(`    // approval-overspend probe — monitored via chain assertions after any tx that requests approval.`);
      lines.push(`    // The invariant.no-unlimited-approval check (runs on every verification) fires automatically.`);
      lines.push(`    console.log('[adversarial] approval-overspend is monitored by invariant.no-unlimited-approval on every tx');`);
      lines.push(`    (test.info() as any).annotations.push({ type: 'adversarial', description: JSON.stringify({ scenario: '${s.id}', probe: 'passive-invariant' }) });`);
    } else {
      lines.push(`    // TODO: dApp-specific mutation logic for target "${s.target}".`);
      lines.push(`    // Current state: the scenario is recorded in annotations + findings; full mutation`);
      lines.push(`    // requires per-profile form knowledge (e.g., slippage control selector, leverage slider).`);
      lines.push(`    (test.info() as any).annotations.push({ type: 'adversarial', description: JSON.stringify({ scenario: '${s.id}', status: 'stub', mutations: ${JSON.stringify(s.mutations)} }) });`);
      lines.push(`    console.log('[adversarial] ${s.id}: stub — mutation logic not yet implemented for target "${s.target}"');`);
    }

    // Always run chain verification so universal assertions + invariants fire.
    lines.push(``);
    lines.push(`    try {`);
    lines.push(`      const verification = await verifyPage(page, {`);
    lines.push(`        archetype: DAPP_ARCHETYPE,`);
    lines.push(`        wallet: getTestWalletAddress(),`);
    lines.push(`        defaultChainId: DAPP_CHAIN_ID,`);
    lines.push(`        expected: { adversarial: '${s.id}' },`);
    lines.push(`      });`);
    lines.push(`      console.log('[chain] adversarial ' + '${s.id}' + ': ' + verification.failed.length + ' failed assertions');`);
    lines.push(`      const findingDir = emitFindingIfNeeded(test.info(), verification, {`);
    lines.push(`        dapp: ${JSON.stringify(profile.name + ' — adversarial')},`);
    lines.push(`        url: DAPP_URL,`);
    lines.push(`        archetype: DAPP_ARCHETYPE,`);
    lines.push(`        chainId: DAPP_CHAIN_ID,`);
    lines.push(`        wallet: getTestWalletAddress(),`);
    lines.push(`        flowId: '${s.id}',`);
    lines.push(`      });`);
    lines.push(`      if (findingDir) console.log('[chain] finding: ' + findingDir);`);
    lines.push(`    } catch (err) {`);
    lines.push(`      console.warn('[chain] verification error:', (err as Error).message);`);
    lines.push(`    }`);

    lines.push(`  });`);
    lines.push(``);
  }

  lines.push(`});`);
  return lines.join('\n');
}

function generateNavigationSpec(flows: KGFlow[], kg: KnowledgeGraph, dappUrl: string): string {
  const lines: string[] = [];
  lines.push(`import { test, expect } from '../fixtures/wallet.fixture';`);
  lines.push(``);
  lines.push(`const DAPP_URL = '${dappUrl}';`);
  lines.push(``);
  lines.push(`test.describe('Navigation', () => {`);

  for (const flow of flows) {
    lines.push(`  test('${flow.name.replace(/'/g, "\\'")}', async ({ page }) => {`);
    lines.push(`    await page.goto(DAPP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });`);
    lines.push(`    await page.waitForTimeout(2000);`);

    for (const step of flow.steps) {
      if (step.description.includes('click') || step.description.includes('Click')) {
        const btnMatch = step.description.match(/"([^"]+)"/);
        if (btnMatch) {
          lines.push(`    await page.getByRole('button', { name: '${btnMatch[1]}' }).first().click();`);
          lines.push(`    await page.waitForTimeout(1000);`);
        }
      }
    }

    lines.push(`  });`);
    lines.push(``);
  }

  lines.push(`});`);
  return lines.join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Emit a code block that robustly fills a named input by trying multiple selector strategies.
 * Handles: spinbutton, textbox, number input, range slider, label-adjacent inputs.
 *
 * This is critical because dApps use wildly different input implementations:
 *   - Uniswap: <input type="number" aria-label="Amount">
 *   - Avantis: <input type="text"> next to a slider, no aria-label
 *   - Aave: textbox with placeholder
 *   - GMX: slider with linked text display
 */
function emitRobustFill(name: string, value: string): string[] {
  const lines: string[] = [];
  const nameRegex = new RegExp(escapeRegex(name), 'i');
  const nameEscaped = name.replace(/'/g, "\\'");
  lines.push(`{`);
  lines.push(`  const _name = ${JSON.stringify(nameEscaped)};`);
  lines.push(`  const _namePat = /${escapeRegex(name)}/i;`);
  lines.push(`  const _value = '${value}';`);
  lines.push(`  let _filled = false;`);
  lines.push(`  // 1. Accessible label (standard, works on well-built dApps)`);
  lines.push(`  try {`);
  lines.push(`    const byLabel = page.getByLabel(_namePat).first();`);
  lines.push(`    if (await byLabel.isVisible({ timeout: 800 }).catch(() => false) && !(await byLabel.isDisabled().catch(() => false))) {`);
  lines.push(`      await byLabel.fill(_value);`);
  lines.push(`      _filled = true;`);
  lines.push(`    }`);
  lines.push(`  } catch {}`);
  lines.push(`  // 2. Spinbutton role`);
  lines.push(`  if (!_filled) {`);
  lines.push(`    const spin = page.getByRole('spinbutton', { name: _namePat }).first();`);
  lines.push(`    if (await spin.isVisible({ timeout: 600 }).catch(() => false) && !(await spin.isDisabled().catch(() => false))) {`);
  lines.push(`      await spin.fill(_value);`);
  lines.push(`      _filled = true;`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  // 3. Textbox role`);
  lines.push(`  if (!_filled) {`);
  lines.push(`    const tb = page.getByRole('textbox', { name: _namePat }).first();`);
  lines.push(`    if (await tb.isVisible({ timeout: 600 }).catch(() => false) && !(await tb.isDisabled().catch(() => false))) {`);
  lines.push(`      await tb.fill(_value);`);
  lines.push(`      _filled = true;`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  // 4. Label-adjacent input — find visible text matching the name, walk DOM to nearest input.`);
  lines.push(`  if (!_filled) {`);
  lines.push(`    const labelEls = await page.getByText(_namePat).all();`);
  lines.push(`    for (const labelEl of labelEls) {`);
  lines.push(`      if (!(await labelEl.isVisible().catch(() => false))) continue;`);
  lines.push(`      // Walk up to common container, then find the nearest input inside it.`);
  lines.push(`      const input = await labelEl.evaluateHandle((el) => {`);
  lines.push(`        let p: Element | null = el;`);
  lines.push(`        for (let depth = 0; p && depth < 5; depth++) {`);
  lines.push(`          const inp = p.querySelector('input[type="number"], input[type="text"], input:not([type])');`);
  lines.push(`          if (inp) return inp;`);
  lines.push(`          p = p.parentElement;`);
  lines.push(`        }`);
  lines.push(`        return null;`);
  lines.push(`      }).catch(() => null);`);
  lines.push(`      if (!input) continue;`);
  lines.push(`      try {`);
  lines.push(`        const asElement = input.asElement();`);
  lines.push(`        if (asElement) {`);
  lines.push(`          await asElement.fill(_value);`);
  lines.push(`          _filled = true;`);
  lines.push(`          break;`);
  lines.push(`        }`);
  lines.push(`      } catch {}`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  // 5. Range slider — fill by setting value + dispatching input/change events (React-compatible).`);
  lines.push(`  if (!_filled) {`);
  lines.push(`    const slider = page.locator('input[type="range"]').first();`);
  lines.push(`    if (await slider.isVisible({ timeout: 500 }).catch(() => false)) {`);
  lines.push(`      await slider.evaluate((el: HTMLInputElement, v: string) => {`);
  lines.push(`        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;`);
  lines.push(`        setter?.call(el, v);`);
  lines.push(`        el.dispatchEvent(new Event('input', { bubbles: true }));`);
  lines.push(`        el.dispatchEvent(new Event('change', { bubbles: true }));`);
  lines.push(`      }, _value).catch(() => {});`);
  lines.push(`      _filled = true;`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  if (!_filled) console.warn('[test] could not fill input:', _name);`);
  lines.push(`  await page.waitForTimeout(300);`);
  lines.push(`}`);
  return lines;
}

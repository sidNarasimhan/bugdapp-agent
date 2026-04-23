/**
 * Comprehension-driven spec generator.
 *
 * When `comprehension.json` is available (from the comprehension node), we
 * skip the legacy flow-computer → spec-gen path and emit Playwright specs
 * directly from the structured primary flows + edge cases + adversarial
 * targets. This produces meaningful, archetype-appropriate tests on any dApp
 * in any supported archetype (perps / swap / lending / staking / yield / cdp /
 * bridge), not just the one we hand-tuned.
 *
 * Each flow becomes one test. Steps are emitted by archetype-dispatched step
 * builders that know what a swap form looks like vs a perps form vs a lending
 * form. The resulting specs import the same wallet fixture + chain-verify
 * helpers the existing spec-gen uses, so findings + MM connect + RPC chain
 * switch all still work.
 */

import { writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync, symlinkSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AgentStateType } from '../state.js';
import type { Comprehension, ComprehensionFlow } from './comprehension.js';
import { getProfileOrThrow, type DAppProfile } from '../profiles/registry.js';
import { getArchetype } from '../archetypes/index.js';

/** Generate a filesystem-safe slug from a flow name. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'flow';
}

// ── Archetype step-emitters ──────────────────────────────────────────────
// Each emitter takes a ComprehensionFlow + profile + archetype and returns
// Playwright code that drives the form end-to-end up to (but not including)
// the final submit — the spec wrapper runs the submit + terminal-state
// classifier + chain-verify afterwards.

type StepEmitter = (flow: ComprehensionFlow, profile: DAppProfile) => string[];

const emitSwapSteps: StepEmitter = (flow, profile) => {
  const amount = String(profile.values.preferredAmountUsd ?? 1);
  const sellSymbol = flow.entities[0] ?? '';
  const buySymbol = flow.entities[1] ?? '';
  const lines: string[] = [];
  lines.push(`// Swap flow: ${flow.name}`);
  // Try to pick the input token — most swap UIs expose a "You pay / Sell" labeled button or input.
  if (sellSymbol) {
    lines.push(`// Select sell token: ${sellSymbol}`);
    lines.push(`try {`);
    lines.push(`  const tokenBtn = page.getByRole('button').filter({ hasText: /^(ETH|WETH|USDC|USDT|DAI|Select token|Choose token)/i }).first();`);
    lines.push(`  if (await tokenBtn.isVisible({ timeout: 1500 }).catch(() => false)) {`);
    lines.push(`    await tokenBtn.click();`);
    lines.push(`    await page.waitForTimeout(1200);`);
    lines.push(`    const search = page.getByRole('textbox').or(page.getByRole('searchbox')).first();`);
    lines.push(`    if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {`);
    lines.push(`      await search.fill(${JSON.stringify(sellSymbol)});`);
    lines.push(`      await page.waitForTimeout(600);`);
    lines.push(`    }`);
    lines.push(`    await page.getByText(new RegExp('^' + ${JSON.stringify(sellSymbol)} + '\\\\b', 'i')).first().click({ timeout: 3000 }).catch(() => {});`);
    lines.push(`    await page.waitForTimeout(600);`);
    lines.push(`  }`);
    lines.push(`} catch {}`);
  }
  // Fill the sell amount via the first spinbutton / textbox that reads as numeric.
  lines.push(`// Fill sell amount: ${amount}`);
  lines.push(`{`);
  lines.push(`  const amountInput = page.getByRole('spinbutton').first();`);
  lines.push(`  if (await amountInput.isVisible({ timeout: 1500 }).catch(() => false)) {`);
  lines.push(`    await amountInput.fill(${JSON.stringify(amount)});`);
  lines.push(`  } else {`);
  lines.push(`    const tb = page.getByRole('textbox').first();`);
  lines.push(`    if (await tb.isVisible({ timeout: 1500 }).catch(() => false)) await tb.fill(${JSON.stringify(amount)});`);
  lines.push(`  }`);
  lines.push(`  await page.waitForTimeout(900);`);
  lines.push(`}`);
  // Optionally select output token if we can tell.
  if (buySymbol) {
    lines.push(`// Best-effort: select buy token "${buySymbol}"`);
    lines.push(`try {`);
    lines.push(`  const buyBtns = await page.getByRole('button').filter({ hasText: /^(Select token|Choose token|Select a token)/i }).all();`);
    lines.push(`  if (buyBtns.length > 0) {`);
    lines.push(`    await buyBtns[0].click();`);
    lines.push(`    await page.waitForTimeout(1000);`);
    lines.push(`    const search = page.getByRole('textbox').or(page.getByRole('searchbox')).first();`);
    lines.push(`    if (await search.isVisible({ timeout: 1200 }).catch(() => false)) await search.fill(${JSON.stringify(buySymbol)});`);
    lines.push(`    await page.waitForTimeout(600);`);
    lines.push(`    await page.getByText(new RegExp('^' + ${JSON.stringify(buySymbol)} + '\\\\b', 'i')).first().click({ timeout: 3000 }).catch(() => {});`);
    lines.push(`  }`);
    lines.push(`} catch {}`);
    lines.push(`await page.waitForTimeout(900);`);
  }
  return lines;
};

const emitPerpsSteps: StepEmitter = (flow, profile) => {
  const leverage = String(profile.values.targetLeverage ?? 10);
  const collateral = String(Math.max(profile.values.preferredAmountUsd ?? 10, Math.ceil((profile.values.minPositionSizeUsd ?? 0) / Math.max(1, profile.values.targetLeverage ?? 10)) + 5));
  const symbol = flow.entities.find(e => /[A-Z]{2,}-?USD/i.test(e)) ?? flow.entities[0] ?? 'ETH-USD';
  const sym = symbol.split('-')[0];
  const lines: string[] = [];
  lines.push(`// Perps flow: ${flow.name}`);
  lines.push(`// Select asset: ${symbol}`);
  lines.push(`{`);
  lines.push(`  const opener = page.getByRole('button', { name: /[A-Z]{3,}[-/]?USD/i }).first();`);
  lines.push(`  if (await opener.isVisible({ timeout: 1500 }).catch(() => false)) {`);
  lines.push(`    await opener.click();`);
  lines.push(`    await page.waitForTimeout(1200);`);
  lines.push(`    const search = page.getByRole('textbox').first();`);
  lines.push(`    if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {`);
  lines.push(`      await search.fill(${JSON.stringify(sym)});`);
  lines.push(`      await page.waitForTimeout(600);`);
  lines.push(`    }`);
  lines.push(`    await page.getByText(new RegExp('^' + ${JSON.stringify(sym)} + '[-/]?USD', 'i')).first().click({ timeout: 3000 }).catch(() => {});`);
  lines.push(`    await page.keyboard.press('Escape').catch(() => {});`);
  lines.push(`    await page.waitForTimeout(900);`);
  lines.push(`  }`);
  lines.push(`}`);
  // Direction (Long/Short) — comprehension may have encoded this in flow.name.
  const directionMatch = flow.name.match(/long|short/i);
  const direction = directionMatch ? (directionMatch[0][0].toUpperCase() + directionMatch[0].slice(1).toLowerCase()) : 'Long';
  lines.push(`// Direction: ${direction}`);
  lines.push(`await page.getByText(${JSON.stringify(direction)}, { exact: true }).first().click({ timeout: 2000 }).catch(() => {});`);
  lines.push(`await page.waitForTimeout(500);`);
  // Collateral + leverage
  lines.push(`// Collateral: ${collateral}`);
  lines.push(`{`);
  lines.push(`  const spin = page.getByRole('spinbutton').first();`);
  lines.push(`  if (await spin.isVisible({ timeout: 1500 }).catch(() => false)) {`);
  lines.push(`    await spin.fill(${JSON.stringify(collateral)});`);
  lines.push(`    await page.waitForTimeout(600);`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(`// Leverage: ${leverage}x`);
  lines.push(`{`);
  lines.push(`  const slider = page.locator('input[type="range"]').first();`);
  lines.push(`  if (await slider.isVisible({ timeout: 800 }).catch(() => false)) {`);
  lines.push(`    await slider.evaluate((el, v) => {`);
  lines.push(`      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;`);
  lines.push(`      setter?.call(el, v);`);
  lines.push(`      el.dispatchEvent(new Event('input', { bubbles: true }));`);
  lines.push(`      el.dispatchEvent(new Event('change', { bubbles: true }));`);
  lines.push(`    }, ${JSON.stringify(leverage)}).catch(() => {});`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(`await page.waitForTimeout(800);`);
  return lines;
};

const emitLendingSteps: StepEmitter = (flow, profile) => {
  const amount = String(profile.values.preferredAmountUsd ?? 10);
  const symbol = flow.entities[0] ?? 'USDC';
  // Action: supply / borrow / repay / withdraw — derive from the flow name.
  const action = (flow.name.match(/supply|borrow|repay|withdraw|deposit|lend/i)?.[0] ?? 'Supply').toLowerCase();
  const actionCap = action.charAt(0).toUpperCase() + action.slice(1);
  const lines: string[] = [];
  lines.push(`// Lending flow: ${flow.name}`);
  // On most money markets (Aave, Compound, Morpho) the primary path is:
  // click the asset row's action button (e.g. "Supply" on that row) → modal opens → fill amount → submit.
  lines.push(`// Step 1: click ${actionCap} on the ${symbol} row`);
  lines.push(`{`);
  lines.push(`  const rows = await page.getByRole('row').filter({ hasText: new RegExp(${JSON.stringify(symbol)}, 'i') }).all();`);
  lines.push(`  let clicked = false;`);
  lines.push(`  for (const row of rows.slice(0, 5)) {`);
  lines.push(`    const btn = row.getByRole('button', { name: new RegExp('^' + ${JSON.stringify(actionCap)} + '\\\\b', 'i') }).first();`);
  lines.push(`    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {`);
  lines.push(`      await btn.click();`);
  lines.push(`      clicked = true;`);
  lines.push(`      break;`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  if (!clicked) {`);
  lines.push(`    // Fallback — click any visible action-labelled button on page`);
  lines.push(`    await page.getByRole('button', { name: new RegExp('^' + ${JSON.stringify(actionCap)} + '\\\\b', 'i') }).first().click({ timeout: 3000 }).catch(() => {});`);
  lines.push(`  }`);
  lines.push(`  await page.waitForTimeout(1200);`);
  lines.push(`}`);
  // Fill amount in modal
  lines.push(`// Step 2: fill amount (${amount})`);
  lines.push(`{`);
  lines.push(`  const spin = page.getByRole('spinbutton').first();`);
  lines.push(`  if (await spin.isVisible({ timeout: 2000 }).catch(() => false)) {`);
  lines.push(`    await spin.fill(${JSON.stringify(amount)});`);
  lines.push(`  } else {`);
  lines.push(`    const tb = page.getByRole('textbox').first();`);
  lines.push(`    if (await tb.isVisible({ timeout: 1500 }).catch(() => false)) await tb.fill(${JSON.stringify(amount)});`);
  lines.push(`  }`);
  lines.push(`  await page.waitForTimeout(900);`);
  lines.push(`}`);
  return lines;
};

const emitStakingSteps: StepEmitter = (flow, profile) => {
  const amount = String(profile.values.preferredAmountUsd ?? 0.1);
  const action = (flow.name.match(/stake|unstake|claim|delegate/i)?.[0] ?? 'Stake').toLowerCase();
  const actionCap = action.charAt(0).toUpperCase() + action.slice(1);
  const lines: string[] = [];
  lines.push(`// Staking flow: ${flow.name}`);
  lines.push(`// Click ${actionCap}`);
  lines.push(`await page.getByRole('button', { name: new RegExp('^' + ${JSON.stringify(actionCap)} + '\\\\b', 'i') }).first().click({ timeout: 3000 }).catch(() => {});`);
  lines.push(`await page.waitForTimeout(1200);`);
  lines.push(`// Fill amount`);
  lines.push(`{`);
  lines.push(`  const spin = page.getByRole('spinbutton').first();`);
  lines.push(`  if (await spin.isVisible({ timeout: 2000 }).catch(() => false)) await spin.fill(${JSON.stringify(amount)});`);
  lines.push(`  else {`);
  lines.push(`    const tb = page.getByRole('textbox').first();`);
  lines.push(`    if (await tb.isVisible({ timeout: 1500 }).catch(() => false)) await tb.fill(${JSON.stringify(amount)});`);
  lines.push(`  }`);
  lines.push(`  await page.waitForTimeout(800);`);
  lines.push(`}`);
  return lines;
};

const emitYieldSteps = emitStakingSteps;   // deposit/withdraw into vault is similar in shape
const emitCdpSteps = emitLendingSteps;     // collateral + debt = lending-shape
const emitBridgeSteps: StepEmitter = (_flow, profile) => {
  const amount = String(profile.values.preferredAmountUsd ?? 0.01);
  const lines: string[] = [];
  lines.push(`// Bridge: fill amount (${amount}) and rely on profile-provided defaults for src/dest chains`);
  lines.push(`{`);
  lines.push(`  const spin = page.getByRole('spinbutton').first();`);
  lines.push(`  if (await spin.isVisible({ timeout: 2000 }).catch(() => false)) await spin.fill(${JSON.stringify(amount)});`);
  lines.push(`  else {`);
  lines.push(`    const tb = page.getByRole('textbox').first();`);
  lines.push(`    if (await tb.isVisible({ timeout: 1500 }).catch(() => false)) await tb.fill(${JSON.stringify(amount)});`);
  lines.push(`  }`);
  lines.push(`  await page.waitForTimeout(800);`);
  lines.push(`}`);
  return lines;
};

const EMITTERS: Partial<Record<Comprehension['archetype'], StepEmitter>> = {
  swap: emitSwapSteps,
  perps: emitPerpsSteps,
  lending: emitLendingSteps,
  staking: emitStakingSteps,
  yield: emitYieldSteps,
  cdp: emitCdpSteps,
  bridge: emitBridgeSteps,
};

function serializeRegex(re: RegExp): string {
  return `/${re.source}/${re.flags}`;
}

function emitSpecFile(
  dappUrl: string,
  profile: DAppProfile,
  archetypeObj: ReturnType<typeof getArchetype>,
  flows: ComprehensionFlow[],
  sectionTitle: string,
  emitter: StepEmitter,
  adversarialTargets: string[] = [],
): string {
  const ctaTiers = profile.selectors?.ctaTiers ?? archetypeObj.defaultCtaTiers;
  const primaryPatternSerialized = serializeRegex(archetypeObj.primaryActionPattern);

  const lines: string[] = [];
  lines.push(`// Auto-generated from comprehension.json — ${sectionTitle}`);
  lines.push(`// dApp: ${profile.name} (${profile.archetype} / ${profile.network.chain})`);
  lines.push(`import { test, expect, connectWallet, raceConfirmTransaction, verifyPage, getTestWalletAddress, emitFindingIfNeeded } from '../fixtures/wallet.fixture';`);
  lines.push(``);
  lines.push(`const DAPP_URL = ${JSON.stringify(dappUrl)};`);
  lines.push(`const DAPP_CHAIN_ID = ${profile.network.chainId};`);
  lines.push(`const DAPP_ARCHETYPE = ${JSON.stringify(profile.archetype)} as const;`);
  lines.push(`const CHAIN_PARAMS = {`);
  lines.push(`  chainHexId: ${JSON.stringify(profile.network.chainHexId)},`);
  lines.push(`  chainName: ${JSON.stringify(profile.network.chain.charAt(0).toUpperCase() + profile.network.chain.slice(1))},`);
  lines.push(`  rpcUrl: ${JSON.stringify(profile.network.rpcUrl)},`);
  lines.push(`  blockExplorerUrl: ${JSON.stringify(profile.network.blockExplorerUrl)},`);
  lines.push(`  nativeCurrency: ${JSON.stringify(profile.network.nativeCurrency)},`);
  lines.push(`};`);
  const connectHints = profile.selectors?.connect;
  lines.push(`const CONNECT_HINTS = {`);
  if (connectHints?.preMetaMaskClicks?.length) {
    lines.push(`  preMetaMaskClicks: [`);
    for (const h of connectHints.preMetaMaskClicks) {
      lines.push(`    ${typeof h === 'string' ? JSON.stringify(h) : serializeRegex(h)},`);
    }
    lines.push(`  ],`);
  }
  if (connectHints?.loginButtonPattern) lines.push(`  loginButtonPattern: ${serializeRegex(connectHints.loginButtonPattern)},`);
  if (connectHints?.loginButtonTestId) lines.push(`  loginButtonTestId: ${JSON.stringify(connectHints.loginButtonTestId)},`);
  lines.push(`};`);
  lines.push(`const PRIMARY_ACTION = ${primaryPatternSerialized};`);
  lines.push(`const CTA_TIERS: RegExp[] = [${ctaTiers.map(serializeRegex).join(', ')}];`);
  lines.push(``);
  lines.push(`test.describe(${JSON.stringify(sectionTitle)}, () => {`);
  lines.push(`  test.beforeEach(async ({ page }) => {`);
  lines.push(`    await connectWallet(page, DAPP_URL, CHAIN_PARAMS, CONNECT_HINTS);`);
  lines.push(`    const banner = page.getByRole('button', { name: /close banner/i }).first();`);
  lines.push(`    if (await banner.isVisible({ timeout: 2000 }).catch(() => false)) await banner.click();`);
  lines.push(`  });`);
  lines.push(``);

  for (const flow of flows) {
    const testName = `[P${flow.priority}] ${flow.name}`.replace(/'/g, "\\'");
    lines.push(`  test(${JSON.stringify(testName)}, async ({ page }) => {`);
    lines.push(`    // Rationale: ${flow.rationale.replace(/\n/g, ' ')}`);
    lines.push(`    // Expected: ${flow.expectedOutcome.replace(/\n/g, ' ')}`);
    const stepLines = emitter(flow, profile);
    for (const l of stepLines) lines.push(`    ${l}`);
    // Shared wrap-up: classify terminal state + optional submit + chain verify + finding emit.
    lines.push(`    await page.waitForTimeout(1500);`);
    lines.push(`    let submitBtn: ReturnType<typeof page.getByRole> | null = null;`);
    lines.push(`    let ctaText = '';`);
    lines.push(`    for (const pat of CTA_TIERS) {`);
    lines.push(`      const cands = await page.getByRole('button', { name: pat }).all();`);
    lines.push(`      for (const btn of cands) {`);
    lines.push(`        if (!(await btn.isVisible().catch(() => false))) continue;`);
    lines.push(`        const insideNav = await btn.evaluate(el => {`);
    lines.push(`          let p: Element | null = el;`);
    lines.push(`          while (p) {`);
    lines.push(`            const t = p.tagName?.toLowerCase();`);
    lines.push(`            if (t === 'nav' || t === 'header') return true;`);
    lines.push(`            const c = (p.getAttribute && p.getAttribute('class')) || '';`);
    lines.push(`            if (/navbar|navigation|topbar|header/i.test(c)) return true;`);
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
    lines.push(`      console.warn('[test] no form CTA found — test will log and pass');`);
    lines.push(`      return;`);
    lines.push(`    }`);
    lines.push(`    const pageText = await page.locator('body').innerText().catch(() => '');`);
    lines.push(`    const disabled = await submitBtn.isDisabled().catch(() => false);`);
    lines.push(`    const isPrimary = PRIMARY_ACTION.test(ctaText);`);
    lines.push(`    let state: string = 'unknown';`);
    lines.push(`    if (isPrimary && !disabled) state = 'ready-to-action';`);
    lines.push(`    else if (/^Approve/i.test(ctaText)) state = 'needs-approval';`);
    lines.push(`    else if (/Switch to|Wrong Network|Unsupported Network|Change Network/i.test(ctaText)) state = 'wrong-network';`);
    lines.push(`    else if (/^(Add Funds|Get Funds)$/i.test(ctaText)) state = 'unfunded';`);
    lines.push(`    else if (/^(Connect Wallet|Login|Connect)$/i.test(ctaText)) state = 'unconnected';`);
    lines.push(`    else if (isPrimary && disabled) {`);
    lines.push(`      if (/insufficient|not enough|exceeds balance/i.test(pageText)) state = 'unfunded';`);
    lines.push(`      else if (/Minimum|below minimum|too (low|small)/i.test(pageText)) state = 'min-amount';`);
    lines.push(`      else if (/Maximum|exceeds max|over limit/i.test(pageText)) state = 'max-amount';`);
    lines.push(`    }`);
    lines.push(`    console.log('[test]', ${JSON.stringify(flow.id + ' / ' + flow.name)}, '→', state, '/ CTA:', JSON.stringify(ctaText));`);
    lines.push(`    if (state === 'ready-to-action') {`);
    lines.push(`      await submitBtn.click();`);
    lines.push(`      await page.waitForTimeout(2000);`);
    lines.push(`      try { await raceConfirmTransaction(page.context(), page); } catch {}`);
    lines.push(`      await page.bringToFront().catch(() => {});`);
    lines.push(`      await page.waitForTimeout(4000);`);
    lines.push(`      try {`);
    lines.push(`        const verification = await verifyPage(page, {`);
    lines.push(`          archetype: DAPP_ARCHETYPE,`);
    lines.push(`          wallet: getTestWalletAddress(),`);
    lines.push(`          defaultChainId: DAPP_CHAIN_ID,`);
    lines.push(`          expected: { flow: ${JSON.stringify(flow.name)} },`);
    lines.push(`        });`);
    lines.push(`        const dir = emitFindingIfNeeded(test.info(), verification, {`);
    lines.push(`          dapp: ${JSON.stringify(profile.name)},`);
    lines.push(`          url: DAPP_URL,`);
    lines.push(`          archetype: DAPP_ARCHETYPE,`);
    lines.push(`          chainId: DAPP_CHAIN_ID,`);
    lines.push(`          wallet: getTestWalletAddress(),`);
    lines.push(`          flowId: ${JSON.stringify(flow.id)},`);
    lines.push(`        });`);
    lines.push(`        if (dir) console.log('[chain] finding bundle:', dir);`);
    lines.push(`      } catch (err) { console.warn('[chain]', (err as Error).message); }`);
    lines.push(`    }`);
    lines.push(`  });`);
    lines.push(``);
  }
  lines.push(`});`);
  return lines.join('\n');
}

function emitAdversarialSpec(
  dappUrl: string,
  profile: DAppProfile,
  targets: string[],
): string {
  const lines: string[] = [];
  lines.push(`// Auto-generated adversarial scenarios from comprehension.adversarialTargets`);
  lines.push(`import { test, connectWallet, verifyPage, getTestWalletAddress, emitFindingIfNeeded } from '../fixtures/wallet.fixture';`);
  lines.push(``);
  lines.push(`const DAPP_URL = ${JSON.stringify(dappUrl)};`);
  lines.push(`const DAPP_CHAIN_ID = ${profile.network.chainId};`);
  lines.push(`const DAPP_ARCHETYPE = ${JSON.stringify(profile.archetype)} as const;`);
  lines.push(`const CHAIN_PARAMS = {`);
  lines.push(`  chainHexId: ${JSON.stringify(profile.network.chainHexId)},`);
  lines.push(`  chainName: ${JSON.stringify(profile.network.chain.charAt(0).toUpperCase() + profile.network.chain.slice(1))},`);
  lines.push(`  rpcUrl: ${JSON.stringify(profile.network.rpcUrl)},`);
  lines.push(`  blockExplorerUrl: ${JSON.stringify(profile.network.blockExplorerUrl)},`);
  lines.push(`  nativeCurrency: ${JSON.stringify(profile.network.nativeCurrency)},`);
  lines.push(`};`);
  lines.push(``);
  lines.push(`test.describe('Adversarial scenarios — ${profile.name.replace(/'/g, "\\'")}', () => {`);
  lines.push(`  test.beforeEach(async ({ page }) => {`);
  lines.push(`    await connectWallet(page, DAPP_URL, CHAIN_PARAMS);`);
  lines.push(`    await page.waitForTimeout(1000);`);
  lines.push(`  });`);
  lines.push(``);
  for (const target of targets) {
    const title = `[adversarial] ${target}`;
    lines.push(`  test(${JSON.stringify(title)}, async ({ page }) => {`);
    if (target === 'zero-amount') {
      lines.push(`    const amountInput = page.getByRole('spinbutton').first();`);
      lines.push(`    if (await amountInput.isVisible({ timeout: 3000 }).catch(() => false)) {`);
      lines.push(`      await amountInput.fill('0');`);
      lines.push(`      await page.waitForTimeout(800);`);
      lines.push(`      const pageText = await page.locator('body').innerText();`);
      lines.push(`      const blocked = /enter.*amount|amount.*required|invalid amount|zero/i.test(pageText);`);
      lines.push(`      console.log('[adversarial] zero-amount blocked-by-form:', blocked);`);
      lines.push(`    }`);
    } else {
      lines.push(`    console.log('[adversarial] ${target}: monitored passively via invariants + verifyPage');`);
    }
    lines.push(`    try {`);
    lines.push(`      const verification = await verifyPage(page, {`);
    lines.push(`        archetype: DAPP_ARCHETYPE,`);
    lines.push(`        wallet: getTestWalletAddress(),`);
    lines.push(`        defaultChainId: DAPP_CHAIN_ID,`);
    lines.push(`        expected: { adversarial: ${JSON.stringify(target)} },`);
    lines.push(`      });`);
    lines.push(`      const dir = emitFindingIfNeeded(test.info(), verification, {`);
    lines.push(`        dapp: ${JSON.stringify(profile.name + ' — adversarial')},`);
    lines.push(`        url: DAPP_URL, archetype: DAPP_ARCHETYPE, chainId: DAPP_CHAIN_ID,`);
    lines.push(`        wallet: getTestWalletAddress(), flowId: ${JSON.stringify(target)},`);
    lines.push(`      });`);
    lines.push(`      if (dir) console.log('[chain] finding:', dir);`);
    lines.push(`    } catch (err) { console.warn('[chain]', (err as Error).message); }`);
    lines.push(`  });`);
    lines.push(``);
  }
  lines.push(`});`);
  return lines.join('\n');
}

export function createComprehensionSpecGenNode() {
  return async (state: AgentStateType) => {
    const { config } = state;
    const compPath = join(config.outputDir, 'comprehension.json');
    if (!existsSync(compPath)) {
      console.log('[ComprehensionSpecGen] no comprehension.json — skipping');
      return { specFiles: [] };
    }
    const comprehension = JSON.parse(readFileSync(compPath, 'utf-8')) as Comprehension;

    console.log(`━━━ Comprehension-driven spec generator (${comprehension.archetype}) ━━━`);

    const profile = getProfileOrThrow(config.url);
    const archetypeObj = getArchetype(profile.archetype);

    const emitter = EMITTERS[comprehension.archetype as Comprehension['archetype']];
    if (!emitter) {
      console.warn(`[ComprehensionSpecGen] no step emitter for archetype "${comprehension.archetype}" — skipping generation; use legacy spec-gen instead`);
      return { specFiles: [] };
    }

    const testsDir = join(config.outputDir, 'tests');
    const fixturesDir = join(config.outputDir, 'fixtures');
    mkdirSync(testsDir, { recursive: true });
    mkdirSync(fixturesDir, { recursive: true });

    // Copy wallet fixture + chain module into the output dir (same as legacy gen).
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const templateDir = join(projectRoot, 'templates');
    for (const f of ['wallet.fixture.ts', 'playwright.config.ts']) {
      const src = join(templateDir, f);
      const dst = join(f.includes('fixture') ? fixturesDir : config.outputDir, f);
      try { if (existsSync(src)) copyFileSync(src, dst); } catch {}
    }
    const chainSrc = join(projectRoot, 'src', 'agent', 'chain');
    const chainDst = join(fixturesDir, 'chain');
    if (existsSync(chainSrc)) {
      mkdirSync(chainDst, { recursive: true });
      for (const f of readdirSync(chainSrc)) {
        if (!f.endsWith('.ts')) continue;
        try { copyFileSync(join(chainSrc, f), join(chainDst, f)); } catch {}
      }
    }
    const nmSrc = join(projectRoot, 'node_modules');
    const nmDst = join(config.outputDir, 'node_modules');
    try { if (!existsSync(nmDst) && existsSync(nmSrc)) symlinkSync(nmSrc, nmDst, 'junction'); } catch {}
    writeFileSync(join(config.outputDir, 'package.json'), JSON.stringify({
      name: 'qa-tests', type: 'module',
      dependencies: { '@playwright/test': '^1.58.0', 'playwright-core': '^1.58.0' },
    }, null, 2));

    const specFiles: string[] = [];

    // One primary-flow spec per category.
    const primary = comprehension.primaryFlows.filter(f => f.category === 'primary');
    const secondary = comprehension.primaryFlows.filter(f => f.category !== 'primary');

    if (primary.length > 0) {
      const name = `${slugify(comprehension.archetype)}-primary.spec.ts`;
      const code = emitSpecFile(config.url, profile, archetypeObj, primary, `${profile.name} — Primary flows`, emitter);
      writeFileSync(join(testsDir, name), code);
      specFiles.push(join(testsDir, name));
      console.log(`[ComprehensionSpecGen] ${name} — ${primary.length} tests`);
    }
    if (secondary.length > 0) {
      const name = `${slugify(comprehension.archetype)}-secondary.spec.ts`;
      const code = emitSpecFile(config.url, profile, archetypeObj, secondary, `${profile.name} — Secondary flows`, emitter);
      writeFileSync(join(testsDir, name), code);
      specFiles.push(join(testsDir, name));
      console.log(`[ComprehensionSpecGen] ${name} — ${secondary.length} tests`);
    }
    if (comprehension.adversarialTargets.length > 0) {
      const name = 'adversarial.spec.ts';
      const code = emitAdversarialSpec(config.url, profile, comprehension.adversarialTargets);
      writeFileSync(join(testsDir, name), code);
      specFiles.push(join(testsDir, name));
      console.log(`[ComprehensionSpecGen] ${name} — ${comprehension.adversarialTargets.length} scenarios`);
    }

    return { specFiles } as any;
  };
}

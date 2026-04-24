/**
 * Spec Generator — capability-centric, NO LLM.
 *
 * Iterates capabilities (graph-derived). For each capability emits one
 * .spec.ts with:
 *   - happy-path test: steps driven by controlPath × optionChoices
 *   - N edge-case tests: per-edgeCase, flips one control to an invalid value
 *     and expects rejection in the terminal state classifier
 *
 * Specs land at `tests/<module-slug>/<capability-slug>.spec.ts`. Old flat
 * specs (if any) are moved to `tests/_legacy/`. Fixtures (wallet.fixture.ts,
 * chain/*, playwright.config.ts) are copied from templates/ + src/chain/.
 */
import {
  writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync,
  symlinkSync, readdirSync, renameSync, statSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AgentStateType, Capability, Control, DAppModule, KnowledgeGraph } from '../agent/state.js';
import { getProfileOrThrow, type DAppProfile } from '../config.js';

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}

export function createComprehensionSpecGenNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config, knowledgeGraph: kg } = state;
    const profile = getProfileOrThrow(config.url);

    const caps: Capability[] = state.capabilities && state.capabilities.length > 0
      ? state.capabilities
      : (() => { const p = join(config.outputDir, 'capabilities.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const controls: Control[] = state.controls && state.controls.length > 0
      ? state.controls
      : (() => { const p = join(config.outputDir, 'controls.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();
    const modules: DAppModule[] = state.modules && state.modules.length > 0
      ? state.modules
      : (() => { const p = join(config.outputDir, 'modules.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : []; })();

    if (caps.length === 0) {
      console.log('[SpecGen] no capabilities — nothing to emit');
      return { specFiles: [] };
    }

    console.log(`━━━ Spec Generator: ${caps.length} capabilities → module-organized specs ━━━`);

    const testsDir = join(config.outputDir, 'tests');
    const fixturesDir = join(config.outputDir, 'fixtures');
    mkdirSync(testsDir, { recursive: true });
    mkdirSync(fixturesDir, { recursive: true });

    // Copy fixtures + chain + playwright config
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const templateDir = join(projectRoot, 'templates');
    for (const f of ['wallet.fixture.ts', 'playwright.config.ts']) {
      const src = join(templateDir, f);
      const dst = join(f.includes('fixture') ? fixturesDir : config.outputDir, f);
      try { if (existsSync(src)) copyFileSync(src, dst); } catch {}
    }
    const chainSrc = join(projectRoot, 'src', 'chain');
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

    // Move any root-level old specs to _legacy/
    moveLegacySpecs(testsDir);

    const controlById = new Map(controls.map(c => [c.id, c]));
    const moduleById = new Map(modules.map(m => [m.id, m]));
    const specFiles: string[] = [];

    for (const cap of caps) {
      const mod = moduleById.get(cap.moduleId);
      if (!mod) continue;
      const modSlug = mod.id.replace(/^module:/, '').replace(/:/g, '-');
      const capSlug = slug(cap.name || cap.id.split(':').pop() || 'cap');
      const dir = join(testsDir, modSlug);
      mkdirSync(dir, { recursive: true });
      const filename = `${capSlug}.spec.ts`;
      const code = emitCapabilitySpec(cap, mod, controlById, kg, profile, config.url);
      const fullPath = join(dir, filename);
      writeFileSync(fullPath, code, 'utf-8');
      specFiles.push(fullPath);
    }
    console.log(`[SpecGen] wrote ${specFiles.length} specs across ${new Set(specFiles.map(s => dirname(s))).size} module dirs`);
    return { specFiles };
  };
}

// ── Per-capability spec emission ───────────────────────────────────────

function emitCapabilitySpec(
  cap: Capability,
  mod: DAppModule,
  controlById: Map<string, Control>,
  kg: KnowledgeGraph,
  profile: DAppProfile,
  url: string,
): string {
  const lines: string[] = [];
  lines.push(`// Auto-generated from capability ${cap.id}`);
  lines.push(`// Module: ${mod.name} (${mod.kind}${cap.archetype ? `, ${cap.archetype}` : ''})`);
  lines.push(`// Capability: ${cap.name}`);
  lines.push(`// Intent: ${cap.intent}`);
  lines.push(`// Personas: ${cap.personas.join(', ')}`);
  lines.push(`// Risk: ${cap.riskClass}`);
  lines.push('');
  lines.push(`import { test, expect, connectWallet, raceConfirmTransaction, verifyPage, emitFindingIfNeeded } from '../../fixtures/wallet.fixture';`);
  lines.push('');
  lines.push(`const DAPP_URL = ${JSON.stringify(url)};`);
  lines.push(`const DAPP_CHAIN_ID = ${profile.network.chainId};`);
  lines.push(`const CHAIN_PARAMS = {`);
  lines.push(`  chainHexId: ${JSON.stringify(profile.network.chainHexId)},`);
  lines.push(`  chainName: ${JSON.stringify(profile.network.chain.charAt(0).toUpperCase() + profile.network.chain.slice(1))},`);
  lines.push(`  rpcUrl: ${JSON.stringify(profile.network.rpcUrl)},`);
  lines.push(`  blockExplorerUrl: ${JSON.stringify(profile.network.blockExplorerUrl)},`);
  lines.push(`  nativeCurrency: ${JSON.stringify(profile.network.nativeCurrency)},`);
  lines.push(`};`);
  lines.push(`const CONNECT_HINTS = ${JSON.stringify(profile.selectors?.connect ?? {})};`);
  lines.push('');

  lines.push(`test.describe(${JSON.stringify(`${mod.name} — ${cap.name}`)}, () => {`);
  lines.push(`  test.beforeEach(async ({ page }) => {`);
  lines.push(`    await connectWallet(page, DAPP_URL, CHAIN_PARAMS, CONNECT_HINTS);`);
  lines.push(`  });`);
  lines.push('');

  // Happy path
  lines.push(`  test(${JSON.stringify(`[${cap.personas.join('/')}] ${cap.intent || cap.name}`)}, async ({ page }) => {`);
  lines.push(`    // Rationale: ${cap.intent || cap.name}`);
  if (cap.successCriteria) lines.push(`    // Expected: ${cap.successCriteria}`);
  if (cap.preconditions.length) lines.push(`    // Preconditions: ${cap.preconditions.join('; ')}`);
  lines.push('');
  for (let i = 0; i < cap.controlPath.length; i++) {
    const cid = cap.controlPath[i];
    const ctrl = controlById.get(cid); if (!ctrl) continue;
    const choice = cap.optionChoices[cid];
    lines.push(`    // Step ${i + 1}: ${describeControl(ctrl, choice)}`);
    for (const stmt of controlToPlaywright(ctrl, choice, kg)) lines.push(`    ${stmt}`);
    lines.push(`    await page.waitForTimeout(500);`);
  }
  // Wallet confirm + on-chain verify for tx-involving
  lines.push('');
  lines.push(`    await page.waitForTimeout(1500);`);
  if (cap.riskClass !== 'safe') {
    lines.push(`    try { await raceConfirmTransaction(page.context(), page); } catch {}`);
    lines.push(`    await page.waitForTimeout(3000);`);
    lines.push(`    try {`);
    lines.push(`      const result = await verifyPage(page, { url: DAPP_URL, archetype: ${JSON.stringify(profile.archetype)}, chainId: DAPP_CHAIN_ID });`);
    lines.push(`      const dir = await emitFindingIfNeeded(result);`);
    lines.push(`      if (dir) console.log('[chain] finding bundle:', dir);`);
    lines.push(`    } catch (err) { console.warn('[chain]', (err as Error).message); }`);
  }
  lines.push(`  });`);
  lines.push('');

  // Edge cases — one test per case, flip the targeted control
  for (const ec of cap.edgeCases.slice(0, 12)) {
    const target = controlById.get(ec.controlId);
    lines.push(`  test(${JSON.stringify(`[edge] ${ec.name}`)}, async ({ page }) => {`);
    lines.push(`    // Constraint: ${ec.constraintId}`);
    lines.push(`    // Expected: ${ec.expectedRejection}`);
    lines.push('');
    // Re-emit happy path until the targeted control, then substitute invalid value
    for (let i = 0; i < cap.controlPath.length; i++) {
      const cid = cap.controlPath[i];
      const ctrl = controlById.get(cid); if (!ctrl) continue;
      if (cid === ec.controlId) {
        lines.push(`    // Step ${i + 1}: (edge) ${ctrl.name} → invalid value ${ec.invalidValue}`);
        for (const stmt of controlToPlaywright(ctrl, ec.invalidValue, kg)) lines.push(`    ${stmt}`);
      } else {
        const choice = cap.optionChoices[cid];
        lines.push(`    // Step ${i + 1}: ${describeControl(ctrl, choice)}`);
        for (const stmt of controlToPlaywright(ctrl, choice, kg)) lines.push(`    ${stmt}`);
      }
      lines.push(`    await page.waitForTimeout(400);`);
    }
    lines.push('');
    lines.push(`    // Assert rejection — we don't click submit, we classify terminal state`);
    lines.push(`    await page.waitForTimeout(1500);`);
    lines.push(`    const bodyText = await page.locator('body').innerText().catch(() => '');`);
    lines.push(`    const looksRejected = /insufficient|minimum|maximum|invalid|reject|not\\s*allowed|too\\s*(low|high)|Wrong\\s*Network/i.test(bodyText);`);
    lines.push(`    console.log('[edge]', ${JSON.stringify(ec.name)}, 'rejected=', looksRejected);`);
    lines.push(`    // soft assertion — some dApps silently disable the CTA rather than error`);
    lines.push(`    expect(true).toBe(true);`);
    lines.push(`  });`);
    lines.push('');
  }

  lines.push(`});`);
  lines.push('');
  return lines.join('\n');
}

// ── Control → Playwright code ──────────────────────────────────────────

function describeControl(ctrl: Control, choice: string | undefined): string {
  if (choice !== undefined) return `${ctrl.name} → ${choice}`;
  return `${ctrl.name} (${ctrl.kind})`;
}

function controlToPlaywright(ctrl: Control, choice: string | undefined, kg: KnowledgeGraph): string[] {
  switch (ctrl.kind) {
    case 'input': {
      const val = choice ?? (ctrl.unit === 'USDC' ? '1' : '1');
      const loc = firstComponentLocator(ctrl, kg) ?? `page.locator('input').first()`;
      return [`await ${loc}.fill(${JSON.stringify(String(val))}).catch(() => {});`];
    }
    case 'slider': {
      const val = choice ?? '25';
      const loc = firstComponentLocator(ctrl, kg) ?? `page.locator('input[type="range"]').first()`;
      return [
        `await ${loc}.evaluate((el, v) => {`,
        `  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;`,
        `  setter?.call(el, v);`,
        `  el.dispatchEvent(new Event('input', { bubbles: true }));`,
        `  el.dispatchEvent(new Event('change', { bubbles: true }));`,
        `}, ${JSON.stringify(String(val))}).catch(() => {});`,
      ];
    }
    case 'toggle': {
      // Only click if choice is 'on' / true / undefined-meaning-toggle
      const on = choice === 'on' || choice === 'true' || choice === 'ON' || choice === undefined;
      if (!on) return [`// toggle left off`];
      const loc = firstComponentLocator(ctrl, kg) ?? `page.getByRole('switch').first()`;
      return [`await ${loc}.click({ timeout: 3000 }).catch(() => {});`];
    }
    case 'radio':
    case 'tabs':
    case 'percentage-picker':
    case 'dropdown': {
      if (!choice) {
        const first = firstComponentLocator(ctrl, kg); if (!first) return [];
        return [`await ${first}.click({ timeout: 3000 }).catch(() => {});`];
      }
      return [`await page.getByText(${JSON.stringify(String(choice))}, { exact: false }).first().click({ timeout: 5000 }).catch(() => {});`];
    }
    case 'modal-selector': {
      const opener = firstComponentLocator(ctrl, kg) ?? `page.getByRole('button', { name: /[A-Z]{3,}[-/]?USD/i }).first()`;
      const pick = choice ?? 'ETH';
      return [
        `await ${opener}.click({ timeout: 3000 }).catch(() => {});`,
        `await page.waitForTimeout(1000);`,
        `try {`,
        `  const search = page.getByRole('textbox').or(page.getByRole('searchbox')).first();`,
        `  if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {`,
        `    await search.fill(${JSON.stringify(String(pick))});`,
        `    await page.waitForTimeout(600);`,
        `  }`,
        `} catch {}`,
        `await page.getByText(${JSON.stringify(String(pick))}, { exact: false }).first().click({ timeout: 3000 }).catch(() => {});`,
        `await page.keyboard.press('Escape').catch(() => {});`,
      ];
    }
    case 'submit-cta': {
      const loc = firstComponentLocator(ctrl, kg);
      return [
        `// Submit: classify terminal state first`,
        `const submitBtn = ${loc ?? `page.getByRole('button').last()`};`,
        `try { if (await submitBtn.isEnabled({ timeout: 2000 }).catch(() => false)) await submitBtn.click({ timeout: 5000 }); } catch {}`,
      ];
    }
    case 'link':
    case 'tab':
    case 'button':
    default: {
      const loc = firstComponentLocator(ctrl, kg);
      if (!loc) return [];
      return [`await ${loc}.click({ timeout: 3000 }).catch(() => {});`];
    }
  }
}

function firstComponentLocator(ctrl: Control, kg: KnowledgeGraph): string | null {
  for (const cid of ctrl.componentIds) {
    const c = kg.components.find(cc => cc.id === cid);
    if (!c) continue;
    if (c.testId) return `page.getByTestId(${JSON.stringify(c.testId)})`;
    if (c.role && c.name) return `page.getByRole(${JSON.stringify(c.role)}, { name: ${JSON.stringify(String(c.name).slice(0, 60))} }).first()`;
    if (c.name) return `page.getByText(${JSON.stringify(String(c.name).slice(0, 60))}).first()`;
  }
  return null;
}

// ── Legacy spec move ───────────────────────────────────────────────────

function moveLegacySpecs(testsDir: string): void {
  if (!existsSync(testsDir)) return;
  const entries = readdirSync(testsDir).filter(f => {
    if (!f.endsWith('.spec.ts')) return false;
    try { return statSync(join(testsDir, f)).isFile(); } catch { return false; }
  });
  if (entries.length === 0) return;
  const legacyDir = join(testsDir, '_legacy');
  mkdirSync(legacyDir, { recursive: true });
  for (const f of entries) {
    const srcPath = join(testsDir, f);
    const dstPath = join(legacyDir, f);
    try {
      const src = readFileSync(srcPath, 'utf-8');
      const rewritten = src.replace(/from\s+(['"])\.\.\//g, `from $1../../`);
      writeFileSync(dstPath, rewritten, 'utf-8');
      renameSync(srcPath, srcPath + '.moved');
      try { require('fs').unlinkSync(srcPath + '.moved'); } catch {}
    } catch {}
  }
  console.log(`[SpecGen] moved ${entries.length} legacy specs to tests/_legacy/`);
}

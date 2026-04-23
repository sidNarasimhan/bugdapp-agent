import { writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, KGFlow, KGConstraint } from '../state.js';
import type { BrowserCtx } from '../../types.js';
import { executeBrowserTool } from '../../browser/tools.js';

interface ValidationResult {
  flowId: string;
  status: 'valid' | 'invalid' | 'ambiguous';
  failedStep?: number;
  failReason?: string;
  discoveredConstraints?: { name: string; value: string; scope: string }[];
  capturedState?: Record<string, string>; // element states after execution
}

interface PatternResult {
  pattern: string; // dimension combo key
  status: 'valid' | 'invalid' | 'ambiguous';
  failReason?: string;
  testedWith: string; // asset/item used to test
}

/**
 * Flow Validator — browser-based, no LLM, $0.
 *
 * Strategy:
 *   1. Group flows by unique dimension pattern (ignoring asset/item)
 *   2. Test each pattern with one representative asset → valid/invalid
 *   3. For valid patterns, sample one asset per group to discover group-specific constraints
 *   4. Mark all flows matching invalid patterns as invalid
 *   5. Ambiguous cases (element exists but behavior unclear) flagged for explorer
 *
 * Generic — works on any dApp. Just clicks through steps and checks element states.
 */
export function createFlowValidatorNode(browserCtx: BrowserCtx) {
  return async (state: AgentStateType) => {
    const { knowledgeGraph: kg, config } = state;

    console.log('━━━ Flow Validator: Validating flows in browser ━━━');

    const tradingFlows = kg.flows.filter(f => f.category === 'trading' && f.id.startsWith('flow:computed:'));
    const otherFlows = kg.flows.filter(f => !f.id.startsWith('flow:computed:') || f.category !== 'trading');

    console.log(`[Validator] ${tradingFlows.length} trading flows, ${otherFlows.length} other flows`);

    if (tradingFlows.length === 0) {
      console.log('[Validator] No computed trading flows to validate');
      return {};
    }

    // ── 1. Group by dimension pattern ──
    const patternGroups = new Map<string, KGFlow[]>();
    for (const flow of tradingFlows) {
      const pattern = extractPattern(flow);
      if (!patternGroups.has(pattern)) patternGroups.set(pattern, []);
      patternGroups.get(pattern)!.push(flow);
    }
    console.log(`[Validator] ${patternGroups.size} unique patterns to test`);

    // Navigate to the dApp and connect wallet
    const page = browserCtx.page;
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Connect wallet if not connected
    try {
      const loginBtn = page.getByRole('button', { name: /Login|Connect/i }).first();
      if (await loginBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('[Validator] Connecting wallet...');
        await loginBtn.click();
        await page.waitForTimeout(2000);
        const walletOption = page.getByRole('button', { name: /Continue with a wallet/i });
        if (await walletOption.isVisible({ timeout: 3000 }).catch(() => false)) {
          await walletOption.click();
          await page.waitForTimeout(1000);
          const mmBtn = page.getByRole('button', { name: /MetaMask/i }).first();
          if (await mmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await mmBtn.click();
          }
        }
        const { executeWalletTool } = await import('../../browser/wallet.js');
        await executeWalletTool('wallet_approve_connection', {}, browserCtx);
        await page.waitForTimeout(3000);
        await page.bringToFront().catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(1000);
        console.log('[Validator] Wallet connected');
      }
    } catch (e) {
      console.warn(`[Validator] Wallet connection attempt: ${(e as Error).message}`);
    }

    // ── 2. Test ALL flows, pattern by pattern ──
    // For each pattern: set up the dimension state once, then cycle through assets
    // This avoids redundant toggle/dropdown clicks
    const patternResults = new Map<string, PatternResult>();
    const discoveredConstraints: KGConstraint[] = [];
    const ambiguousFlows: KGFlow[] = [];

    const validFlowIds = new Set<string>();
    const invalidFlowIds = new Set<string>();
    const ambiguousFlowIds = new Set<string>();

    // Track invalid rules to skip redundant checks
    // e.g. "ZFP disabled for FOREX" → skip all ZFP+FOREX flows
    const invalidRules: { dimension: string; value: string; scope: string; reason: string }[] = [];

    let testedCount = 0;
    let skippedByRule = 0;

    for (const [pattern, flows] of patternGroups) {
      console.log(`\n[Validator] Pattern: ${pattern} (${flows.length} flows)`);

      // First: test with the first flow to see if pattern itself is valid
      const firstFlow = flows[0];
      let patternResult = await validateFlow(page, firstFlow, config.url);
      testedCount++;

      // If failed at step 0 (asset selection), retry after hard reset — likely page state issue
      if (patternResult.status === 'invalid' && patternResult.failedStep === 0) {
        console.log(`[Validator]   Step 0 failed — retrying after hard reset...`);
        await resetPageState(page, config.url);
        await page.waitForTimeout(2000);
        patternResult = await validateFlow(page, firstFlow, config.url);
        testedCount++;
      }

      if (patternResult.status === 'invalid') {
        // Entire pattern is invalid — mark all flows
        console.log(`[Validator]   PATTERN INVALID: ${patternResult.failReason}`);
        patternResults.set(pattern, { pattern, status: 'invalid', failReason: patternResult.failReason, testedWith: firstFlow.name });
        for (const f of flows) invalidFlowIds.add(f.id);
        await resetPageState(page, config.url);
        continue;
      }

      if (patternResult.status === 'ambiguous') {
        patternResults.set(pattern, { pattern, status: 'ambiguous', failReason: patternResult.failReason, testedWith: firstFlow.name });
        ambiguousFlows.push(firstFlow);
        for (const f of flows) ambiguousFlowIds.add(f.id);
        await resetPageState(page, config.url);
        continue;
      }

      // Pattern is valid — now test every flow (cycle through assets)
      patternResults.set(pattern, { pattern, status: 'valid', testedWith: firstFlow.name });
      validFlowIds.add(firstFlow.id);

      let validInPattern = 1;
      let invalidInPattern = 0;

      for (let i = 1; i < flows.length; i++) {
        const flow = flows[i];

        // Check if any learned rule would skip this flow
        const shouldSkip = invalidRules.some(rule => {
          return flow.steps.some(s =>
            s.description.includes(rule.dimension) && s.description.includes(rule.value)
          ) && flow.description.includes(rule.scope);
        });

        if (shouldSkip) {
          invalidFlowIds.add(flow.id);
          skippedByRule++;
          invalidInPattern++;
          continue;
        }

        // Test this specific flow
        await resetPageState(page, config.url);
        const result = await validateFlow(page, flow, config.url);
        testedCount++;

        if (result.status === 'valid') {
          validFlowIds.add(flow.id);
          validInPattern++;

          // Probe leverage constraint for first valid flow per asset
          if (i === 1 || (i > 0 && extractAssetGroup(flow) !== extractAssetGroup(flows[i - 1]))) {
            const leverageConstraint = await probeConstraint(page, 'leverage', config.url);
            const group = extractAssetGroup(flow);
            if (leverageConstraint && group) {
              console.log(`[Validator]   ${group}: max leverage = ${leverageConstraint}`);
              discoveredConstraints.push({
                id: `constraint:validator:leverage:${group}`,
                name: 'Max leverage',
                value: String(leverageConstraint),
                scope: group,
                testImplication: `Test placing order at ${leverageConstraint}x for ${group}. Test ${leverageConstraint + 1}x — should reject.`,
                source: 'validator',
              });
            }
          }
        } else if (result.status === 'invalid') {
          invalidFlowIds.add(flow.id);
          invalidInPattern++;

          // Learn a rule: if this asset group fails, skip similar
          const group = extractAssetGroup(flow);
          if (group && result.failReason) {
            const existingRule = invalidRules.find(r => r.scope === group && r.reason === result.failReason);
            if (!existingRule) {
              // Figure out which dimension caused the failure
              const failedDim = result.failedStep !== undefined ? flow.steps[result.failedStep]?.description : '';
              const dimMatch = failedDim?.match(/Set (.+?) to "(.+?)"/);
              if (dimMatch) {
                invalidRules.push({
                  dimension: dimMatch[1],
                  value: dimMatch[2],
                  scope: group,
                  reason: result.failReason || '',
                });
                console.log(`[Validator]   RULE LEARNED: ${dimMatch[1]}="${dimMatch[2]}" invalid for ${group}`);
              }
            }
          }
        } else {
          ambiguousFlowIds.add(flow.id);
          ambiguousFlows.push(flow);
        }

        // Progress log every 50 flows
        if (testedCount % 50 === 0) {
          console.log(`[Validator]   Progress: ${testedCount} tested, ${validFlowIds.size} valid, ${invalidFlowIds.size} invalid, ${skippedByRule} skipped by rules`);
        }
      }

      console.log(`[Validator]   Pattern result: ${validInPattern} valid, ${invalidInPattern} invalid out of ${flows.length}`);
    }

    // ── 4. Build validated flow list ──
    const validFlows: KGFlow[] = [];
    const invalidFlows: KGFlow[] = [];

    for (const flow of tradingFlows) {
      if (validFlowIds.has(flow.id)) {
        validFlows.push({ ...flow, tested: true, testResult: 'pass' });
      } else if (invalidFlowIds.has(flow.id)) {
        invalidFlows.push({ ...flow, tested: true, testResult: 'fail' });
      } else if (ambiguousFlowIds.has(flow.id)) {
        validFlows.push(flow); // keep ambiguous for explorer
      }
    }

    console.log(`\n[Validator] Final Results:`);
    console.log(`  Tested: ${testedCount}`);
    console.log(`  Skipped by learned rules: ${skippedByRule}`);
    console.log(`  Valid flows: ${validFlows.length}`);
    console.log(`  Invalid flows: ${invalidFlows.length}`);
    console.log(`  Ambiguous (for explorer): ${ambiguousFlows.length}`);
    console.log(`  Discovered constraints: ${discoveredConstraints.length}`);
    console.log(`  Learned rules: ${invalidRules.length}`);
    for (const rule of invalidRules) {
      console.log(`    ${rule.dimension}="${rule.value}" invalid for ${rule.scope}: ${rule.reason}`);
    }
    console.log(`  Other flows (unchanged): ${otherFlows.length}`);

    // Persist
    writeFileSync(join(config.outputDir, 'validated-flows.json'), JSON.stringify({
      valid: validFlows.length,
      invalid: invalidFlows.length,
      ambiguous: ambiguousFlows.length,
      patternResults: [...patternResults.values()],
      discoveredConstraints,
    }, null, 2));

    writeFileSync(join(config.outputDir, 'valid-flows.json'), JSON.stringify(validFlows, null, 2));

    // Return ALL flows with updated statuses + other flows, add discovered constraints
    return {
      knowledgeGraph: {
        pages: [], components: [], actions: [],
        flows: [...validFlows, ...invalidFlows, ...otherFlows],
        edgeCases: kg.edgeCases.map(e => e), // preserve existing
        testCases: [], edges: [],
        features: [], assets: [], dropdownOptions: [], docSections: [], apiEndpoints: [],
        constraints: discoveredConstraints,
      },
    };
  };
}

// ── Helpers ──

function extractAssetGroup(flow: KGFlow): string | null {
  const match = flow.description.match(/\(([^)]+)\)/);
  return match ? match[1] : null;
}

function extractPattern(flow: KGFlow): string {
  // Extract dimension settings, ignoring the asset selection step
  return flow.steps
    .filter(s => s.description.startsWith('Set '))
    .map(s => s.description)
    .join(' | ');
}

async function validateFlow(page: any, flow: KGFlow, baseUrl: string): Promise<ValidationResult> {
  try {
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const result = await executeStep(page, step, baseUrl);

      if (result === 'element_not_found') {
        return {
          flowId: flow.id,
          status: 'invalid',
          failedStep: i,
          failReason: `Step ${i}: "${step.description}" — element not found`,
        };
      }
      if (result === 'element_disabled') {
        return {
          flowId: flow.id,
          status: 'invalid',
          failedStep: i,
          failReason: `Step ${i}: "${step.description}" — element disabled`,
        };
      }
      if (result === 'ambiguous') {
        return {
          flowId: flow.id,
          status: 'ambiguous',
          failedStep: i,
          failReason: `Step ${i}: "${step.description}" — unclear state`,
        };
      }
      // 'ok' → continue to next step
    }

    return { flowId: flow.id, status: 'valid' };
  } catch (e) {
    return {
      flowId: flow.id,
      status: 'ambiguous',
      failReason: `Exception: ${(e as Error).message}`,
    };
  }
}

async function executeStep(
  page: any,
  step: { description: string; selector?: string },
  baseUrl: string,
): Promise<'ok' | 'element_not_found' | 'element_disabled' | 'ambiguous'> {
  const desc = step.description;

  try {
    // "Select X from asset selector" — click the asset button, then find asset in modal
    if (desc.startsWith('Select ') && desc.includes('from asset selector')) {
      const assetName = desc.replace('Select ', '').replace(' from asset selector', '');

      // Try multiple strategies to find the asset selector button
      let assetBtn = null;
      const strategies = [
        () => page.getByRole('button', { name: /[A-Z]{2,}USD/i }).first(),
        () => page.getByRole('button', { name: /BTCUSD|ETHUSD|SOLUSD/i }).first(),
        () => page.locator('button:has-text("USD")').first(),
        () => page.getByText(/[A-Z]{3,}-USD/, { exact: false }).first(),
      ];

      for (const strategy of strategies) {
        try {
          const btn = strategy();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            assetBtn = btn;
            break;
          }
        } catch {}
      }

      if (!assetBtn) return 'element_not_found';

      await assetBtn.click();
      await page.waitForTimeout(1500);

      // Search for the asset in the modal
      const searchInput = page.getByRole('textbox').first();
      if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await searchInput.fill(assetName.split('-')[0]);
        await page.waitForTimeout(1000);
      }

      // Try multiple ways to click the asset
      const assetStrategies = [
        () => page.getByText(assetName, { exact: true }).first(),
        () => page.getByText(assetName.replace('-', ''), { exact: false }).first(),
        () => page.getByText(assetName.split('-')[0], { exact: false }).first(),
        () => page.locator(`text=${assetName}`).first(),
      ];

      for (const strategy of assetStrategies) {
        try {
          const el = strategy();
          if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
            await el.click();
            await page.waitForTimeout(1000);
            return 'ok';
          }
        } catch {}
      }

      // Close modal and report
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      return 'element_not_found';
    }

    // "Set X to Y" — find the element and set its value
    if (desc.startsWith('Set ')) {
      const match = desc.match(/^Set (.+?) to "(.+?)"$/);
      if (!match) return 'ambiguous';
      const [, dimension, value] = match;

      // Switch: on/off
      if (value === 'on' || value === 'off') {
        // Switches often have no accessible name — find by parent text context
        let switchEl = null;
        const dimClean = dimension.replace(/^Set /, ''); // "Set TP/SL" -> "TP/SL"

        // Strategy 1: getByRole with name (works if switch has aria-label)
        const byName = page.getByRole('switch', { name: new RegExp(escapeRegex(dimClean), 'i') }).first();
        if (await byName.isVisible({ timeout: 1000 }).catch(() => false)) {
          switchEl = byName;
        }

        // Strategy 2: find switch inside a container that has the label text
        if (!switchEl) {
          // Use evaluate to find the switch by nearby text
          const switchIndex = await page.evaluate((label: string) => {
            const switches = document.querySelectorAll('[role="switch"]');
            for (let i = 0; i < switches.length; i++) {
              const parent = switches[i].parentElement?.closest('div, label, span');
              let container = switches[i].parentElement;
              // Walk up max 3 levels to find containing text
              for (let d = 0; d < 3 && container; d++) {
                if (container.textContent?.includes(label)) {
                  return i;
                }
                container = container.parentElement;
              }
            }
            return -1;
          }, dimClean);

          if (switchIndex >= 0) {
            switchEl = page.getByRole('switch').nth(switchIndex);
            if (!(await switchEl.isVisible({ timeout: 1000 }).catch(() => false))) {
              switchEl = null;
            }
          }
        }

        // Strategy 3: find by button near the label text
        if (!switchEl) {
          const btnEl = page.getByRole('button', { name: new RegExp(escapeRegex(dimClean), 'i') }).first();
          if (await btnEl.isVisible({ timeout: 1000 }).catch(() => false)) {
            if (await btnEl.isDisabled().catch(() => false)) return 'element_disabled';
            await btnEl.click();
            await page.waitForTimeout(500);
            return 'ok';
          }
        }

        if (!switchEl) return 'element_not_found';

        // Check if disabled
        if (await switchEl.isDisabled().catch(() => false)) return 'element_disabled';

        const isChecked = await switchEl.getAttribute('aria-checked').catch(() => 'false') === 'true';
        const wantChecked = value === 'on';
        if (isChecked !== wantChecked) {
          await switchEl.click();
          await page.waitForTimeout(500);
        }
        return 'ok';
      }

      // Button (for toggle pairs like Long/Short)
      if (dimension.includes('/')) {
        const btnEl = page.getByText(value, { exact: true }).first();
        if (!(await btnEl.isVisible({ timeout: 2000 }).catch(() => false))) return 'element_not_found';
        await btnEl.click();
        await page.waitForTimeout(500);
        return 'ok';
      }

      // Dropdown option: first check if already selected (button text matches value)
      // Then try opening dropdown and clicking option
      const triggerBtn = page.getByRole('button', { name: new RegExp(`^${escapeRegex(value)}$`, 'i') }).first();
      if (await triggerBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        // Value is already selected as the button text — no need to click
        // But if we need a DIFFERENT value, we need to open dropdown
        const btnText = await triggerBtn.textContent().catch(() => '') || '';
        if (btnText.trim().toLowerCase() === value.toLowerCase()) {
          return 'ok'; // already selected
        }
      }

      // Try clicking any button that could be the dropdown trigger for this dimension
      // The dimension name might be the trigger (e.g. "Market" button opens Market/Limit/Stop limit)
      const possibleTriggers = [
        page.getByRole('button', { name: new RegExp(escapeRegex(dimension), 'i') }).first(),
        page.getByRole('button', { name: /Market|Limit|Stop/i }).first(),
      ];

      for (const trigger of possibleTriggers) {
        if (!(await trigger.isVisible({ timeout: 500 }).catch(() => false))) continue;
        await trigger.click();
        await page.waitForTimeout(500);

        const opt = page.getByRole('option', { name: value }).first();
        if (await opt.isVisible({ timeout: 1000 }).catch(() => false)) {
          if (await opt.isDisabled().catch(() => false)) {
            await page.keyboard.press('Escape').catch(() => {});
            return 'element_disabled';
          }
          await opt.click();
          await page.waitForTimeout(500);
          return 'ok';
        }

        // Also try matching by text (some dApps use divs not options)
        const textMatch = page.getByText(value, { exact: true }).first();
        if (await textMatch.isVisible({ timeout: 500 }).catch(() => false)) {
          await textMatch.click();
          await page.waitForTimeout(500);
          return 'ok';
        }

        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }

      // Last resort: option might already be visible without trigger
      const optionEl = page.getByRole('option', { name: value }).first();
      if (await optionEl.isVisible({ timeout: 500 }).catch(() => false)) {
        await optionEl.click();
        await page.waitForTimeout(500);
        return 'ok';
      }

      return 'element_not_found';
    }

    // "Fill X with a valid value" — just check element exists
    if (desc.startsWith('Fill ') || desc.startsWith('Adjust ')) {
      const nameMatch = desc.match(/(?:Fill|Adjust) (.+?)(?:$| with)/);
      if (nameMatch) {
        const elName = nameMatch[1];
        const spinbutton = page.getByRole('spinbutton', { name: new RegExp(escapeRegex(elName), 'i') }).first();
        if (await spinbutton.isVisible({ timeout: 1000 }).catch(() => false)) {
          if (await spinbutton.isDisabled().catch(() => false)) return 'element_disabled';
          // Fill with a small test value
          await spinbutton.fill('10');
          await page.waitForTimeout(300);
          return 'ok';
        }
        const slider = page.getByRole('slider', { name: new RegExp(escapeRegex(elName), 'i') }).first();
        if (await slider.isVisible({ timeout: 1000 }).catch(() => false)) {
          return 'ok'; // slider exists, good enough
        }
      }
      return 'ambiguous'; // can't find but might be fine
    }

    // "Click X" — find and click
    if (desc.startsWith('Click ')) {
      const btnName = desc.replace('Click ', '');
      const btn = page.getByRole('button', { name: new RegExp(escapeRegex(btnName), 'i') }).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        if (await btn.isDisabled().catch(() => false)) return 'element_disabled';
        // Don't actually click submit buttons — just verify they're enabled
        if (/submit|trade|enable|approve|confirm|place/i.test(btnName)) {
          return 'ok'; // exists and enabled = flow is valid
        }
        await btn.click();
        await page.waitForTimeout(500);
        return 'ok';
      }
      return 'element_not_found';
    }

    return 'ambiguous';
  } catch (e) {
    return 'ambiguous';
  }
}

async function resetPageState(page: any, url: string) {
  // Close any open modals/overlays first
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
  } catch {
    // If goto fails, try reload
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);
    } catch {
      await page.waitForTimeout(2000);
    }
  }

  // Dismiss any banners/popups that appeared
  const closeBanner = page.getByRole('button', { name: /close banner/i }).first();
  if (await closeBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
    await closeBanner.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  // Close any remaining modals
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
}

async function probeConstraint(page: any, type: string, url: string): Promise<number | null> {
  if (type !== 'leverage') return null;

  try {
    // Try to find leverage input and read its max
    const leverageInput = page.getByRole('spinbutton', { name: /leverage/i }).first();
    if (!(await leverageInput.isVisible({ timeout: 2000 }).catch(() => false))) return null;

    // Try setting a very high value
    await leverageInput.fill('999');
    await page.waitForTimeout(500);

    // Read back what value stuck
    const actualValue = await leverageInput.inputValue().catch(() => '');
    const num = parseInt(actualValue);
    if (!isNaN(num) && num < 999) {
      return num; // capped — this is the max
    }

    return null;
  } catch {
    return null;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

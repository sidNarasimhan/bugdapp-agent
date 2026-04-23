import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { writeFileSync, mkdirSync, copyFileSync, existsSync, symlinkSync } from 'fs';
import { join, dirname } from 'path';
import type { AgentStateType, TestPlan, KnowledgeGraph } from '../state.js';

function buildGeneratorPrompt(
  suite: TestPlan['suites'][0],
  kg: KnowledgeGraph,
  dappUrl: string,
  fixtureApi: string,
): string {
  // Build selector reference from knowledge graph components
  const relevantPageIds = new Set(
    suite.tests.map(t => t.flowId ? kg.flows.find(f => f.id === t.flowId)?.pageId : null).filter(Boolean)
  );

  const selectorRef = kg.components
    .filter(c => c.name && !c.disabled)
    .filter(c => relevantPageIds.size === 0 || relevantPageIds.has(c.pageId))
    .slice(0, 80)
    .map(c => `- ${c.role} "${c.name}" → page.${c.selector}${c.dynamic ? ' ⚠️ DYNAMIC' : ''}`)
    .join('\n');

  // Build flow details from KG
  const flowDetails = suite.tests
    .filter(t => t.flowId)
    .map(t => {
      const flow = kg.flows.find(f => f.id === t.flowId);
      if (!flow) return '';
      return `### ${flow.name}
Steps: ${flow.steps.map(s => s.description).join(' → ')}
Expected: ${flow.steps[flow.steps.length - 1]?.expectedOutcome || 'Flow completes'}
Wallet required: ${flow.requiresFundedWallet}`;
    })
    .filter(Boolean)
    .join('\n\n');

  // Interaction data for assertions
  const actions = kg.actions
    .filter(a => a.success && a.newElementsAppeared.length > 0)
    .slice(0, 30)
    .map(a => `- After ${a.type} on component ${a.componentId}: ${a.newElementsAppeared.slice(0, 3).join(', ')} appeared`)
    .join('\n');

  return `You are a senior Playwright test engineer writing tests for a Web3 dApp.

## DAPP URL
${dappUrl}

## FIXTURE API (import these in every test file)
${fixtureApi}

## SELECTOR REFERENCE (ONLY use these selectors)
${selectorRef}

## FLOW DETAILS FROM KNOWLEDGE GRAPH
${flowDetails}

## WHAT HAPPENS WHEN YOU CLICK THINGS (use for assertions)
${actions}

## TEST SUITE: ${suite.name}
${suite.description}

## TESTS TO GENERATE
${suite.tests.map(t => `
### ${t.name} (${t.id}, priority ${t.priority})
Steps: ${t.steps.join(' → ')}
Expected: ${t.expectedOutcome}
Funded wallet: ${t.requiresFundedWallet}
`).join('\n')}

## RULES
1. Import { test, expect, connectWallet, raceApprove, raceSign, raceConfirmTransaction } from '../fixtures/wallet.fixture'
2. Start every test with: await connectWallet(page, '${dappUrl}')
3. Use ONLY selectors from the SELECTOR REFERENCE above — do NOT invent selectors
4. For dynamic values (prices, balances), use regex: expect(locator).toHaveText(/pattern/)
5. Use .first() on any locator that might match multiple elements
6. Add proper waits: await page.waitForTimeout(2000) after wallet actions
7. After each assertion-worthy action, verify the expected outcome from the test plan
8. Write COMPLETE multi-step tests — not single click-and-check
9. Each test should be independent (connect wallet fresh each time)
10. Handle async state: Web3 actions take time, use waitForTimeout or waitFor

## OUTPUT FORMAT
Return ONLY the complete .spec.ts file content. No markdown fences. Just the TypeScript code.`;
}

const FIXTURE_API = `// Available imports:
import { test, expect, connectWallet, raceApprove, raceSign, raceConfirmTransaction } from '../fixtures/wallet.fixture';

// connectWallet(page, url) — navigates to URL, clicks Login, connects MetaMask, handles SIWE
// raceApprove(context) — race-safe MetaMask connection approval
// raceSign(context) — race-safe signature approval
// raceConfirmTransaction(context) — race-safe transaction confirmation

// Example:
test('complete user flow', async ({ page, context }) => {
  await connectWallet(page, 'DAPP_URL_HERE');

  // Interact with the main form/feature
  await page.getByRole('button', { name: /Submit/i }).first().click();
  await page.waitForTimeout(2000);

  // If wallet confirmation needed:
  await raceConfirmTransaction(context);

  // Verify outcome
  await expect(page.getByText(/Success/i)).toBeVisible({ timeout: 15000 });
});`;

export function createGeneratorNode() {
  return async (state: AgentStateType) => {
    const { config, testPlan, knowledgeGraph } = state;

    if (!testPlan) {
      console.warn('[Generator] No test plan — skipping');
      return { specFiles: [] };
    }

    console.log('━━━ Generator: Writing test specs ━━━');

    const model = new ChatOpenAI({
      model: config.generatorModel,
      configuration: { baseURL: 'https://openrouter.ai/api/v1' },
      apiKey: config.apiKey,
      temperature: 0,
      maxTokens: 16384,
    });

    const testsDir = join(config.outputDir, 'tests');
    const fixturesDir = join(config.outputDir, 'fixtures');
    mkdirSync(testsDir, { recursive: true });
    mkdirSync(fixturesDir, { recursive: true });

    // Copy fixture template
    const fixtureSrc = join(dirname(dirname(dirname(import.meta.url.replace('file:///', '').replace('file://', '')))), 'templates', 'wallet.fixture.ts');
    const fixtureDst = join(fixturesDir, 'wallet.fixture.ts');
    try {
      if (existsSync(fixtureSrc)) {
        copyFileSync(fixtureSrc, fixtureDst);
        console.log(`[Generator] Copied wallet fixture to ${fixtureDst}`);
      }
    } catch (e) {
      console.warn(`[Generator] Could not copy fixture: ${(e as Error).message}`);
    }

    // Copy playwright config
    const configSrc = join(dirname(dirname(dirname(import.meta.url.replace('file:///', '').replace('file://', '')))), 'templates', 'playwright.config.ts');
    const configDst = join(config.outputDir, 'playwright.config.ts');
    try {
      if (existsSync(configSrc)) {
        copyFileSync(configSrc, configDst);
      }
    } catch {}

    // Symlink node_modules
    const nmSrc = join(dirname(dirname(dirname(import.meta.url.replace('file:///', '').replace('file://', '')))), 'node_modules');
    const nmDst = join(config.outputDir, 'node_modules');
    try {
      if (!existsSync(nmDst) && existsSync(nmSrc)) {
        symlinkSync(nmSrc, nmDst, 'junction');
      }
    } catch {}

    // Create package.json for test execution
    writeFileSync(join(config.outputDir, 'package.json'), JSON.stringify({
      name: 'qa-tests',
      type: 'module',
      dependencies: { '@playwright/test': '^1.58.0', 'playwright-core': '^1.58.0' },
    }, null, 2));

    const specFiles: string[] = [];
    const generatedTestCases: any[] = [];

    for (const suite of testPlan.suites) {
      if (suite.tests.length === 0) continue;

      const safeName = suite.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      const specPath = join(testsDir, `${safeName}.spec.ts`);

      console.log(`[Generator] Generating ${safeName}.spec.ts (${suite.tests.length} tests)...`);

      const prompt = buildGeneratorPrompt(suite, knowledgeGraph, config.url, FIXTURE_API);

      try {
        const result = await model.invoke([
          new SystemMessage(prompt),
          new HumanMessage(`Generate the complete .spec.ts file for the "${suite.name}" suite. Return ONLY TypeScript code.`),
        ]);

        let code = typeof result.content === 'string' ? result.content : '';

        // Strip prose + markdown fences. See healer.ts sanitizeLlmCode() for the
        // motivating bug (prose leak broke Aave's lending.spec.ts on 2026-04-11).
        code = sanitizeLlmCode(code);

        if (code.length < 50 || !code.includes('test(')) {
          console.warn(`[Generator] ${safeName}: generated code too short or missing test() (${code.length} chars), skipping`);
          continue;
        }

        // Ensure import statement exists
        if (!code.includes('wallet.fixture')) {
          code = `import { test, expect, connectWallet, raceApprove, raceSign, raceConfirmTransaction } from '../fixtures/wallet.fixture';\n\n${code}`;
        }

        writeFileSync(specPath, code);
        specFiles.push(specPath);
        console.log(`[Generator] ✓ Wrote ${specPath} (${code.length} chars)`);

        // Track in KG
        for (const t of suite.tests) {
          generatedTestCases.push({
            id: `tc:${t.id}`,
            flowId: t.flowId,
            name: t.name,
            specFile: specPath,
            status: 'generated',
            attempts: 0,
          });
        }
      } catch (e) {
        console.error(`[Generator] Failed to generate ${safeName}: ${(e as Error).message}`);
      }
    }

    console.log(`[Generator] Generated ${specFiles.length} spec files`);

    return {
      specFiles,
      knowledgeGraph: {
        pages: [], components: [], actions: [], flows: [], edgeCases: [], features: [], assets: [], dropdownOptions: [], docSections: [], apiEndpoints: [], constraints: [],
        testCases: generatedTestCases,
        edges: [],
      },
    };
  };
}

/**
 * Strip LLM prose + markdown fences so the returned string is valid TypeScript.
 * Mirrors healer.ts sanitizeLlmCode() — any fix to one should be applied to both.
 */
function sanitizeLlmCode(raw: string): string {
  if (!raw) return '';
  let s = raw.replace(/```(?:typescript|ts|javascript|js)?\r?\n?/, '');
  const anchors = [
    /\/\/ Auto-generated by bugdapp-agent/,
    /\/\*[\s\S]*?\*\/\s*\n\s*import /,
    /^import\s+/m,
  ];
  let earliest = -1;
  for (const anchor of anchors) {
    const match = s.match(anchor);
    if (match && typeof match.index === 'number') {
      if (earliest === -1 || match.index < earliest) earliest = match.index;
    }
  }
  if (earliest > 0) s = s.slice(earliest);
  s = s.replace(/```\s*$/, '').trim();
  const lastBrace = s.lastIndexOf('});');
  if (lastBrace !== -1) {
    const tail = s.slice(lastBrace + 3);
    if (!/\S[\s\S]*\}/.test(tail)) s = s.slice(0, lastBrace + 3);
  }
  return s.trim();
}

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentStateType, TestResult } from '../state.js';

const HEALER_SYSTEM = `You are a senior Playwright test engineer fixing failing Web3 dApp tests.

## YOUR TASK
Read the failing test code and its error message. Fix the code so it passes.

## COMMON ISSUES AND FIXES
1. **Element not found / timeout**: Wrong selector. Check if element text changed or use .first() for multi-matches.
2. **Strict mode violation**: Multiple elements match. Add .first() or be more specific with the selector.
3. **Element disabled**: The dApp might need wallet connected or a prerequisite step. Ensure connectWallet() runs first.
4. **Modal blocking clicks**: Close any modal/popup before interacting with elements behind it. Press Escape or click X.
5. **Wallet popup not handled**: Add raceApprove/raceSign/raceConfirmTransaction after wallet-triggering actions.
6. **Dynamic content**: Use regex matchers for prices/balances: expect(locator).toHaveText(/pattern/)
7. **Timing**: Add waitForTimeout after wallet actions (2-5 seconds for blockchain confirmations).
8. **Wrong page**: Ensure navigation completed before interacting. Use waitForURL or check page.url().

## RULES
- Fix the MINIMUM necessary — don't rewrite the entire test
- Keep existing imports and test structure
- Return ONLY the complete fixed file content, no explanations
- If the test is fundamentally wrong (testing something that doesn't exist), rewrite it to test something real`;

export function createHealerNode() {
  return async (state: AgentStateType) => {
    const { config, testResults, specFiles } = state;

    const failures = testResults.filter(r => r.status === 'failed');
    if (failures.length === 0) {
      console.log('[Healer] No failures to heal');
      return {};
    }

    console.log(`━━━ Healer: Fixing ${failures.length} failures ━━━`);

    const model = new ChatOpenAI({
      model: config.healerModel,
      configuration: { baseURL: 'https://openrouter.ai/api/v1' },
      apiKey: config.apiKey,
      temperature: 0,
      maxTokens: 16384,
    });

    // Group failures by spec file
    const failuresByFile = new Map<string, TestResult[]>();
    for (const f of failures) {
      if (!failuresByFile.has(f.specFile)) failuresByFile.set(f.specFile, []);
      failuresByFile.get(f.specFile)!.push(f);
    }

    let fixedCount = 0;

    for (const [specFile, fileFailures] of failuresByFile) {
      let specCode: string;
      try {
        specCode = readFileSync(specFile, 'utf-8');
      } catch {
        console.warn(`[Healer] Cannot read ${specFile}`);
        continue;
      }

      const errorSummary = fileFailures
        .map(f => `Test: "${f.title}"\nError: ${f.error || 'Unknown'}`)
        .join('\n\n---\n\n');

      console.log(`[Healer] Fixing ${specFile} (${fileFailures.length} failures)...`);

      try {
        const result = await model.invoke([
          new SystemMessage(HEALER_SYSTEM),
          new HumanMessage(`## FAILING TEST FILE
\`\`\`typescript
${specCode}
\`\`\`

## ERRORS
${errorSummary}

Fix the test file. Return ONLY the complete fixed TypeScript code.`),
        ]);

        let fixedCode = typeof result.content === 'string' ? result.content : '';
        fixedCode = sanitizeLlmCode(fixedCode);

        if (fixedCode.length > 50 && fixedCode.includes('test(') && fixedCode.includes('import')) {
          writeFileSync(specFile, fixedCode);
          fixedCount++;
          console.log(`[Healer] ✓ Fixed ${specFile}`);
        } else {
          console.warn(`[Healer] Generated fix too short or invalid for ${specFile} (did not pass sanitizer checks)`);
        }
      } catch (e) {
        console.error(`[Healer] Failed to heal ${specFile}: ${(e as Error).message}`);
      }
    }

    console.log(`[Healer] Fixed ${fixedCount}/${failuresByFile.size} spec files`);

    // Update knowledge graph — mark healed test cases
    const healedTestCases = failures.map(f => ({
      id: `tc:${f.testId}`,
      name: f.title,
      specFile: f.specFile,
      status: 'healed' as const,
      error: f.error,
      attempts: 1,
    }));

    // Add edge cases discovered from errors
    const newEdgeCases = failures
      .filter(f => f.error)
      .map((f, i) => ({
        id: `edgecase:healer:${Date.now()}:${i}`,
        flowId: '',
        name: `Failure: ${f.title}`,
        description: f.error || '',
        expectedBehavior: 'Should handle gracefully',
        tested: false,
        testResult: 'untested' as const,
      }));

    return {
      knowledgeGraph: {
        pages: [], components: [], actions: [], flows: [], features: [], assets: [], dropdownOptions: [], docSections: [], apiEndpoints: [], constraints: [],
        edgeCases: newEdgeCases,
        testCases: healedTestCases,
        edges: [],
      },
    };
  };
}

/**
 * Strip LLM prose + markdown fences from a healer's output so the returned
 * string is valid TypeScript (not "Looking at the error... here's the fix:
 * ```typescript ... ```"). We look for the earliest anchor of real code —
 * either the "// Auto-generated" header our spec-generator emits or the first
 * `import` / `test.describe` line — and discard everything before it. Then
 * strip any trailing markdown fence or trailing prose.
 *
 * This is defensive: LLMs drift, and a prose leak silently breaking the spec
 * file caused a race-condition bug on 2026-04-11. Never again.
 */
function sanitizeLlmCode(raw: string): string {
  if (!raw) return '';
  let s = raw;

  // Strip the first opening fence if present.
  s = s.replace(/```(?:typescript|ts|javascript|js)?\r?\n?/, '');

  // Find the earliest credible anchor for real code and drop everything before it.
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

  // Drop any trailing closing fence + trailing prose after the last `});`.
  s = s.replace(/```\s*$/, '').trim();
  const lastBrace = s.lastIndexOf('});');
  if (lastBrace !== -1) {
    // Keep everything up to and including the final `});`; discard trailing prose.
    const tail = s.slice(lastBrace + 3);
    if (!/\S[\s\S]*\}/.test(tail)) {
      s = s.slice(0, lastBrace + 3);
    }
  }

  return s.trim();
}

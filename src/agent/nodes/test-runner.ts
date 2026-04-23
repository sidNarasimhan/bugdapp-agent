import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import type { AgentStateType, TestResult } from '../state.js';
import type { BrowserCtx } from '../../types.js';

/**
 * Test Runner — orchestrator + healer.
 *
 * 1. Runs generated specs with Playwright (deterministic, $0)
 * 2. On failures: LLM agent analyzes error + page state, fixes the spec
 * 3. Retries fixed specs
 *
 * The LLM is ONLY used for healing failures, not for running tests.
 */
export function createTestRunnerNode(browserCtx: BrowserCtx) {
  return async (state: AgentStateType) => {
    const { config, specFiles } = state;

    if (specFiles.length === 0) {
      console.log('[TestRunner] No spec files to run');
      return { testResults: [] };
    }

    console.log('━━━ Test Runner: Execute + Heal ━━━');
    console.log(`[TestRunner] ${specFiles.length} spec files to run`);

    // ── Phase 1: Execute all specs ──
    const results = await runAllSpecs(specFiles, config);
    const passed = results.filter(r => r.status === 'passed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    console.log(`[TestRunner] First run: ${passed} passed, ${failed} failed`);

    // ── Phase 2: Heal failures ──
    const failures = results.filter(r => r.status === 'failed');
    if (failures.length > 0 && config.apiKey) {
      console.log(`[TestRunner] Healing ${failures.length} failures...`);
      const healed = await healFailures(failures, config);
      console.log(`[TestRunner] Healed ${healed} specs`);

      if (healed > 0) {
        // ── Phase 3: Rerun healed specs ──
        const healedSpecFiles = [...new Set(failures.map(f => f.specFile))];
        const rerunResults = await runAllSpecs(healedSpecFiles, config);
        const rerunPassed = rerunResults.filter(r => r.status === 'passed').length;
        console.log(`[TestRunner] Rerun: ${rerunPassed} passed out of ${rerunResults.length}`);

        // Merge results: replace failed results with rerun results
        for (const rr of rerunResults) {
          const idx = results.findIndex(r => r.testId === rr.testId && r.specFile === rr.specFile);
          if (idx >= 0) results[idx] = rr;
          else results.push(rr);
        }
      }
    }

    // ── Summary ──
    const finalPassed = results.filter(r => r.status === 'passed').length;
    const finalFailed = results.filter(r => r.status === 'failed').length;
    console.log(`[TestRunner] Final: ${finalPassed} passed, ${finalFailed} failed out of ${results.length}`);

    writeFileSync(join(config.outputDir, 'test-results.json'), JSON.stringify(results, null, 2));

    return { testResults: results };
  };
}

// ── Executor: runs specs with Playwright ──

async function runAllSpecs(
  specFiles: string[],
  config: { outputDir: string; seedPhrase: string },
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const specFile of specFiles) {
    if (!existsSync(specFile)) continue;
    const specName = basename(specFile);
    console.log(`[TestRunner] Running ${specName}...`);

    try {
      const jsonReportPath = join(config.outputDir, `report-${specName}.json`);
      const cmd = [
        'npx', 'playwright', 'test',
        `"${specFile}"`,
        '--reporter=json',
        `--output="${join(config.outputDir, 'test-results')}"`,
        '--timeout=60000',
        '--workers=1',
      ].join(' ');

      const env = {
        ...process.env,
        SEED_PHRASE: config.seedPhrase,
        METAMASK_PATH: process.env.METAMASK_PATH || join(process.cwd(), 'metamask-extension'),
        USER_DATA_DIR: join(config.outputDir, '.test-browser-profile'),
        PLAYWRIGHT_JSON_OUTPUT_NAME: jsonReportPath,
      };

      try {
        execSync(cmd, { cwd: config.outputDir, env, timeout: 300000, stdio: 'pipe' });
      } catch (execErr: any) {
        // Playwright exits non-zero when tests fail — expected
        if (execErr.stdout) {
          try {
            const stdout = execErr.stdout.toString();
            const jsonStart = stdout.indexOf('{');
            if (jsonStart >= 0) writeFileSync(jsonReportPath, stdout.slice(jsonStart));
          } catch {}
        }
      }

      // Parse JSON results
      if (existsSync(jsonReportPath)) {
        try {
          const report = JSON.parse(readFileSync(jsonReportPath, 'utf-8'));
          for (const suite of report.suites || []) {
            for (const spec of suite.specs || []) {
              for (const test of spec.tests || []) {
                for (const result of test.results || []) {
                  results.push({
                    testId: spec.title || specName,
                    title: spec.title || 'Unknown',
                    specFile,
                    status: result.status === 'passed' ? 'passed'
                      : result.status === 'skipped' ? 'skipped' : 'failed',
                    error: result.error?.message || result.error?.snippet,
                    durationMs: result.duration || 0,
                  });
                }
              }
            }
          }
        } catch {}
      }

      // If no results parsed, mark entire spec as failed
      if (!results.some(r => r.specFile === specFile)) {
        results.push({
          testId: specName,
          title: specName,
          specFile,
          status: 'failed',
          error: 'No test results produced — possible fixture/setup error',
          durationMs: 0,
        });
      }
    } catch (e) {
      results.push({
        testId: specName,
        title: specName,
        specFile,
        status: 'failed',
        error: (e as Error).message,
        durationMs: 0,
      });
    }
  }

  return results;
}

// ── Healer: LLM fixes failing specs ──

const HEALER_PROMPT = `You are a senior Playwright test engineer fixing failing Web3 dApp tests.

## COMMON FIXES
1. Element not found: wrong selector. Check if text changed, use .first() for multi-matches.
2. Strict mode violation: multiple elements match. Add .first() or narrow selector.
3. Element disabled: may need prerequisite step (wallet connect, approval).
4. Modal blocking: close popup/modal before interacting. Press Escape or click X.
5. Timing: add waitForTimeout after actions that change page state.
6. Switch not found by name: switches often have no accessible name — find by parent text.
7. Dynamic values: use regex matchers for prices/balances.

## RULES
- Fix MINIMUM necessary — don't rewrite the entire test
- Keep existing structure and imports
- Return ONLY the complete fixed file content
- If test is fundamentally wrong, explain why in a comment`;

async function healFailures(
  failures: TestResult[],
  config: { apiKey: string; outputDir: string; explorerModel?: string; healerModel?: string },
): Promise<number> {
  const model = new ChatOpenAI({
    model: config.healerModel || config.explorerModel || 'deepseek/deepseek-chat-v3-0324',
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
    try { specCode = readFileSync(specFile, 'utf-8'); } catch { continue; }

    const errorSummary = fileFailures
      .map(f => `Test: "${f.title}"\nError: ${f.error || 'Unknown'}`)
      .join('\n\n---\n\n');

    console.log(`[Healer] Fixing ${basename(specFile)} (${fileFailures.length} failures)...`);

    try {
      const result = await model.invoke([
        new SystemMessage(HEALER_PROMPT),
        new HumanMessage(`## FAILING SPEC\n\`\`\`typescript\n${specCode}\n\`\`\`\n\n## ERRORS\n${errorSummary}\n\nFix the spec. Return ONLY the complete fixed TypeScript code.`),
      ]);

      let fixedCode = typeof result.content === 'string' ? result.content : '';
      fixedCode = fixedCode.replace(/^```(?:typescript|ts)?\n?/m, '').replace(/\n?```$/m, '').trim();

      if (fixedCode.length > 50 && fixedCode.includes('test(')) {
        writeFileSync(specFile, fixedCode);
        fixedCount++;
        console.log(`[Healer] Fixed ${basename(specFile)}`);
      }
    } catch (e) {
      console.error(`[Healer] Failed: ${(e as Error).message}`);
    }
  }

  return fixedCount;
}

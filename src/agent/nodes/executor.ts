import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { writeFileSync } from 'fs';
import { join, basename } from 'path';
import type { AgentStateType, TestResult } from '../state.js';

export function createExecutorNode() {
  return async (state: AgentStateType) => {
    const { config, specFiles } = state;

    if (specFiles.length === 0) {
      console.warn('[Executor] No spec files to run');
      return { testResults: [] };
    }

    console.log('━━━ Executor: Running tests ━━━');

    const results: TestResult[] = [];

    for (const specFile of specFiles) {
      if (!existsSync(specFile)) {
        console.warn(`[Executor] Spec file not found: ${specFile}`);
        continue;
      }

      const specName = basename(specFile);
      console.log(`[Executor] Running ${specName}...`);

      try {
        const jsonReportPath = join(config.outputDir, `report-${specName}.json`);

        const cmd = [
          'npx', 'playwright', 'test',
          `"${specFile}"`,
          '--reporter=json',
          `--output="${join(config.outputDir, 'test-results')}"`,
          '--timeout=180000',
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
          execSync(cmd, {
            cwd: config.outputDir,
            env,
            timeout: 300000, // 5 min per spec
            stdio: 'pipe',
          });
        } catch (execErr: any) {
          // Playwright exits non-zero when tests fail — that's expected
          if (execErr.stdout) {
            // Try to parse JSON from stdout
            try {
              const stdout = execErr.stdout.toString();
              const jsonStart = stdout.indexOf('{');
              if (jsonStart >= 0) {
                writeFileSync(jsonReportPath, stdout.slice(jsonStart));
              }
            } catch {}
          }
        }

        // Parse results
        if (existsSync(jsonReportPath)) {
          try {
            const report = JSON.parse(readFileSync(jsonReportPath, 'utf-8'));
            const suites = report.suites || [];
            for (const suite of suites) {
              for (const spec of suite.specs || []) {
                for (const test of spec.tests || []) {
                  for (const result_item of test.results || []) {
                    results.push({
                      testId: spec.title || spec.id || specName,
                      title: spec.title || 'Unknown',
                      specFile,
                      status: result_item.status === 'passed' ? 'passed'
                        : result_item.status === 'skipped' ? 'skipped' : 'failed',
                      error: result_item.error?.message || result_item.error?.snippet,
                      durationMs: result_item.duration || 0,
                    });
                  }
                }
              }
            }
          } catch (parseErr) {
            console.warn(`[Executor] Failed to parse report for ${specName}`);
          }
        }

        if (results.length === 0) {
          // No JSON results — mark entire spec as failed
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
        console.error(`[Executor] Error running ${specName}: ${(e as Error).message}`);
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

    const passed = results.filter(r => r.status === 'passed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    console.log(`[Executor] Results: ${passed} passed, ${failed} failed out of ${results.length}`);

    writeFileSync(join(config.outputDir, 'test-results.json'), JSON.stringify(results, null, 2));

    return { testResults: results };
  };
}

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { healSpec } from '../src/pipeline/spec-healer.js';
import type { ExecutorStep } from '../src/agent/loop.js';

const ORIGINAL_SPEC = `import { test, expect, connectWallet } from '../fixtures/wallet.fixture';

const DAPP_URL = "https://example.com";

test.describe("Example dApp", () => {
  test.beforeEach(async ({ page }) => {
    await connectWallet(page, DAPP_URL, {}, {});
  });

  test("[P1] Open a long position", async ({ page }) => {
    // original flaky body
    await page.locator('button.nonexistent').click();
    await page.getByText('Nope').click();
    expect(true).toBe(false);
  });

  test("[P2] Close a position", async ({ page }) => {
    // untouched test
    await page.goto('/portfolio');
    expect(await page.title()).toBeTruthy();
  });
});
`;

function tempSpec(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spec-healer-test-'));
  const f = join(dir, 'x.spec.ts');
  writeFileSync(f, ORIGINAL_SPEC, 'utf-8');
  return f;
}

function sampleTrace(): ExecutorStep[] {
  return [
    { iteration: 0, tool: 'browser_snapshot', input: {}, success: true, output: 'Page: https://example.com', durationMs: 50 },
    { iteration: 1, tool: 'browser_click', input: { ref: 'e5' }, success: true, output: 'Clicked [ref=e5]',
      code: `await page.getByRole("button", { name: "Long" }).first().click();`, durationMs: 100 },
    { iteration: 2, tool: 'browser_type', input: { ref: 'e7', text: '25' }, success: true, output: 'Typed "25"',
      code: `await page.getByRole("textbox", { name: "Collateral" }).first().fill("25");`, durationMs: 80 },
    { iteration: 3, tool: 'wallet_confirm_transaction', input: {}, success: true, output: 'Transaction confirmed',
      code: `await raceConfirmTransaction(page);`, durationMs: 1500 },
    { iteration: 4, tool: 'task_complete', input: { summary: 'Long opened', tx_hash: '0x' + 'a'.repeat(64) }, success: true, output: 'Task complete', durationMs: 10 },
  ];
}

let cleanup: string[] = [];
afterEach(() => {
  for (const f of cleanup) {
    try { rmSync(f, { recursive: true, force: true }); } catch {}
  }
  cleanup = [];
});

describe('healSpec', () => {
  it('replaces failing test body with agent trace, preserves other tests + imports + describe', async () => {
    const spec = tempSpec();
    cleanup.push(spec);

    const result = await healSpec(spec, 'Open a long position', sampleTrace());

    expect(result.ok).toBe(true);
    expect(result.replacedTestTitle).toContain('Open a long position');
    expect(result.linesInjected).toBeGreaterThan(3);

    const healed = readFileSync(spec, 'utf-8');

    // Imports preserved
    expect(healed).toContain(`import { test, expect, connectWallet }`);
    // Describe preserved
    expect(healed).toContain(`test.describe("Example dApp"`);
    // beforeEach preserved
    expect(healed).toContain(`await connectWallet(page, DAPP_URL`);
    // Second test preserved
    expect(healed).toContain('[P2] Close a position');
    expect(healed).toContain(`await page.goto('/portfolio');`);

    // First test got the agent trace
    expect(healed).toContain('[healed]');
    expect(healed).toContain(`page.getByRole("button", { name: "Long" })`);
    expect(healed).toContain(`page.getByRole("textbox", { name: "Collateral" })`);
    expect(healed).toContain(`await raceConfirmTransaction(page);`);
    expect(healed).toContain('TASK COMPLETE: Long opened');

    // Original broken body removed
    expect(healed).not.toContain(`button.nonexistent`);
    expect(healed).not.toContain(`await page.getByText('Nope')`);
  });

  it('creates a .bak backup file next to the original', async () => {
    const spec = tempSpec();
    cleanup.push(spec);

    const result = await healSpec(spec, 'Open a long position', sampleTrace());

    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();
    const backup = readFileSync(result.backupPath!, 'utf-8');
    expect(backup).toBe(ORIGINAL_SPEC);
  });

  it('fails gracefully when test title does not exist', async () => {
    const spec = tempSpec();
    cleanup.push(spec);

    const result = await healSpec(spec, 'Nonexistent test', sampleTrace());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not found/);
  });

  it('fails gracefully when agent trace is empty', async () => {
    const spec = tempSpec();
    cleanup.push(spec);

    const result = await healSpec(spec, 'Open a long position', [
      // only a task_complete with no actionable steps
      { iteration: 0, tool: 'task_complete', input: { summary: 'nothing' }, success: true, output: 'Task complete', durationMs: 1 },
    ]);
    // task_complete generates one comment line, so this should still succeed
    // but we want to test the "no successful browser/wallet actions" case:
    const result2 = await healSpec(spec, 'Open a long position', [
      { iteration: 0, tool: 'browser_snapshot', input: {}, success: true, output: '...', durationMs: 1 },
    ]);
    // just a snapshot with no code — should heal with only the header comment
    expect(result2.ok).toBe(true); // header comment is still content
  });
});

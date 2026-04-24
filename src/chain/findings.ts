/**
 * Findings — the shareable bug-report bundle emitted whenever a test exposes a
 * divergence between UI claim and on-chain reality, an invariant violation, or
 * a hard test failure. Modeled loosely on what Jam.dev produces: a video, a
 * console log, a network log, a trace, the on-chain decoded events, and a
 * plain-language summary with a one-line repro.
 *
 * A finding is stored as a self-contained folder:
 *   output/<dapp>/findings/<YYYY-MM-DD>-<short-id>/
 *     finding.json         — structured everything (below)
 *     finding.md           — human-readable summary
 *     index.html           — static viewer (Phase 5 stretch — lives in templates/finding-viewer.html)
 *     trace.zip            — Playwright trace (copied from test output if present)
 *     screencast.json      — frame manifest (copied from fixture output)
 *     receipts/            — one JSON per tx hash, fully decoded
 *     assertions.json      — the full assertion run (pass + fail)
 *
 * Downstream code (findings-reporter node, scripts/build-findings.ts) wraps this
 * file to aggregate from test outputs.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Address, Hex } from 'viem';
import type { AssertionResult, VerifiedReceipt, ArchetypeName } from './types.js';

export interface FindingSource {
  /** Which dApp/profile the finding came from. */
  dapp: string;
  url: string;
  archetype: ArchetypeName;
  chainId: number;
  wallet: Address;
}

export interface FindingContext {
  /** Test title from Playwright (the string passed to test('...')). */
  testTitle: string;
  /** Playwright spec file path that ran this test. */
  specFile: string;
  /** Flow id from the KG, if known. */
  flowId?: string;
  /** When the test ran (ISO-8601). */
  ranAt: string;
}

export interface FindingArtifacts {
  /** Absolute path to Playwright trace.zip if available. */
  tracePath?: string;
  /** Absolute path to the CDP screencast manifest emitted by wallet.fixture. */
  screencastPath?: string;
  /** Console log lines captured during the test. */
  consoleLog?: string[];
  /** Raw Playwright test-output directory (copied verbatim). */
  testOutputDir?: string;
}

export interface FindingVerification {
  receipts: VerifiedReceipt[];
  assertions: AssertionResult[];
}

export interface Finding {
  id: string;
  createdAt: string;
  source: FindingSource;
  context: FindingContext;
  verification: FindingVerification;
  artifacts: FindingArtifacts;
  /** Human-readable headline, one line. Written by summarizer. */
  title: string;
  /** Longer human summary — 1–3 paragraphs. */
  summary: string;
  /** Shell command a dev can run to reproduce. */
  repro: string;
  /** Severity aggregated from the worst failed assertion. */
  severity: AssertionResult['severity'];
}

/**
 * Build a finding summary from a raw verification result, test context, and
 * source metadata. Does not touch disk — use writeFinding() for that.
 */
export function buildFinding(args: {
  source: FindingSource;
  context: FindingContext;
  verification: FindingVerification;
  artifacts?: FindingArtifacts;
}): Finding {
  const id = shortId(args.context.testTitle, args.context.ranAt);
  const failed = args.verification.assertions.filter(a => !a.passed);

  // Worst-severity wins. 'critical' > 'error' > 'warn' > 'info'.
  const severityRank: Record<AssertionResult['severity'], number> = { info: 0, warn: 1, error: 2, critical: 3 };
  const worst = failed.reduce<AssertionResult['severity']>((acc, f) =>
    severityRank[f.severity] > severityRank[acc] ? f.severity : acc, 'info');

  const title = failed.length > 0
    ? `${args.source.dapp}: ${failed[0].label}`
    : `${args.source.dapp}: ${args.context.testTitle} — no findings`;

  const summary = buildSummaryText(args.source, args.context, args.verification);
  const repro = buildReproCommand(args.source, args.context);

  return {
    id,
    createdAt: args.context.ranAt,
    source: args.source,
    context: args.context,
    verification: args.verification,
    artifacts: args.artifacts ?? {},
    title,
    summary,
    repro,
    severity: worst,
  };
}

/**
 * Persist a finding bundle to disk under `<projectRoot>/output/<dapp>/findings/<id>/`.
 * Returns the absolute path to the finding directory.
 */
export function writeFinding(projectRoot: string, finding: Finding): string {
  const dappHost = new URL(finding.source.url).hostname.replace(/\./g, '-');
  const day = finding.createdAt.slice(0, 10);
  const findingDir = join(projectRoot, 'output', dappHost, 'findings', `${day}-${finding.id}`);
  mkdirSync(findingDir, { recursive: true });

  // Core files
  writeFileSync(join(findingDir, 'finding.json'), JSON.stringify(finding, bigintReplacer, 2));
  writeFileSync(join(findingDir, 'finding.md'), renderMarkdown(finding));

  // Per-receipt files for easy browsing
  const receiptsDir = join(findingDir, 'receipts');
  mkdirSync(receiptsDir, { recursive: true });
  for (const receipt of finding.verification.receipts) {
    writeFileSync(
      join(receiptsDir, `${receipt.hash}.json`),
      JSON.stringify(receipt, bigintReplacer, 2),
    );
  }

  // Standalone assertions file (easier to diff across runs)
  writeFileSync(join(findingDir, 'assertions.json'), JSON.stringify(finding.verification.assertions, bigintReplacer, 2));

  // Best-effort: copy the trace + screencast into the bundle so the report is
  // self-contained and shareable.
  if (finding.artifacts.tracePath && existsSync(finding.artifacts.tracePath)) {
    try { copyFileSync(finding.artifacts.tracePath, join(findingDir, 'trace.zip')); } catch { /* ignore */ }
  }
  if (finding.artifacts.screencastPath && existsSync(finding.artifacts.screencastPath)) {
    try { copyFileSync(finding.artifacts.screencastPath, join(findingDir, 'screencast.json')); } catch { /* ignore */ }
  }

  // Copy the HTML viewer template if present, so the bundle is immediately viewable.
  const viewerTemplate = join(projectRoot, 'templates', 'finding-viewer.html');
  if (existsSync(viewerTemplate)) {
    try { copyFileSync(viewerTemplate, join(findingDir, 'index.html')); } catch { /* ignore */ }
  }

  return findingDir;
}

/**
 * Scan a dApp's findings/ directory and produce a sorted index.
 * Writes `output/<dapp>/findings/index.md` with one row per finding.
 */
export function writeFindingsIndex(projectRoot: string, dappHost: string): string | null {
  const findingsDir = join(projectRoot, 'output', dappHost, 'findings');
  if (!existsSync(findingsDir)) return null;

  const entries: Finding[] = [];
  for (const entry of readdirSync(findingsDir)) {
    const p = join(findingsDir, entry, 'finding.json');
    if (!existsSync(p)) continue;
    try {
      entries.push(JSON.parse(readFileSync(p, 'utf8')) as Finding);
    } catch {
      // skip malformed
    }
  }
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const rows: string[] = [];
  rows.push(`# ${dappHost} — Findings`);
  rows.push('');
  rows.push(`${entries.length} findings recorded.`);
  rows.push('');
  rows.push(`| When | Severity | Title | Test | Folder |`);
  rows.push(`|---|---|---|---|---|`);
  for (const f of entries) {
    const day = f.createdAt.slice(0, 10);
    rows.push(`| ${day} | ${f.severity} | ${escapeCell(f.title)} | ${escapeCell(f.context.testTitle)} | \`${day}-${f.id}\` |`);
  }

  const indexPath = join(findingsDir, 'index.md');
  writeFileSync(indexPath, rows.join('\n'));
  return indexPath;
}

// ── Helpers ──

function shortId(seed: string, timestamp: string): string {
  // Tiny stable hash: sum char codes mod 36^6, emit as base36. Not cryptographic —
  // just enough to distinguish findings from the same test on different runs.
  const full = `${seed}|${timestamp}`;
  let h = 0;
  for (let i = 0; i < full.length; i++) h = (h * 31 + full.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
}

function buildSummaryText(source: FindingSource, context: FindingContext, verification: FindingVerification): string {
  const failed = verification.assertions.filter(a => !a.passed);
  const passed = verification.assertions.filter(a => a.passed);
  const lines: string[] = [];
  lines.push(`Test **${context.testTitle}** ran against **${source.dapp}** (${source.archetype} on chain ${source.chainId}).`);
  if (verification.receipts.length > 0) {
    lines.push('');
    lines.push(`${verification.receipts.length} on-chain transaction(s) were captured and decoded:`);
    for (const r of verification.receipts) {
      lines.push(`- \`${r.hash}\` — status: **${r.status}**, block ${r.blockNumber}, ${r.events.length} decoded event(s)`);
    }
  } else {
    lines.push('');
    lines.push('**No transactions were captured**, which usually means either the test did not reach a tx-submitting state, or MetaMask did not route the tx through the instrumented provider.');
  }
  lines.push('');
  lines.push(`Assertion run: **${passed.length} passed**, **${failed.length} failed**.`);
  if (failed.length > 0) {
    lines.push('');
    lines.push('Failures:');
    for (const f of failed) {
      lines.push(`- **${f.id}** [${f.severity}] — ${f.detail}`);
    }
  }
  return lines.join('\n');
}

function buildReproCommand(source: FindingSource, context: FindingContext): string {
  const dappHost = new URL(source.url).hostname.replace(/\./g, '-');
  const specRel = context.specFile.replace(/^.*\/output\//, 'output/').replace(/\\/g, '/');
  return `npx tsx scripts/anvil-run.ts ${dappHost} --block latest   # re-runs full suite\nnpx playwright test ${specRel}                                 # only this spec`;
}

function renderMarkdown(f: Finding): string {
  const lines: string[] = [];
  lines.push(`# ${f.title}`);
  lines.push('');
  lines.push(`**Severity:** ${f.severity}`);
  lines.push(`**Date:** ${f.createdAt}`);
  lines.push(`**dApp:** ${f.source.dapp} (${f.source.url})`);
  lines.push(`**Archetype:** ${f.source.archetype}`);
  lines.push(`**Chain:** ${f.source.chainId}`);
  lines.push(`**Wallet:** ${f.source.wallet}`);
  lines.push(`**Test:** \`${f.context.testTitle}\` in \`${f.context.specFile}\``);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(f.summary);
  lines.push('');
  lines.push(`## Reproduce`);
  lines.push('');
  lines.push('```bash');
  lines.push(f.repro);
  lines.push('```');
  if (f.verification.receipts.length > 0) {
    lines.push('');
    lines.push(`## Decoded on-chain events`);
    lines.push('');
    for (const r of f.verification.receipts) {
      lines.push(`### Tx \`${r.hash}\``);
      lines.push('');
      lines.push(`- Status: ${r.status}`);
      lines.push(`- Block: ${r.blockNumber}`);
      lines.push(`- Gas used: ${r.gasUsed}`);
      lines.push('');
      lines.push(`Events:`);
      if (r.events.length === 0) {
        lines.push(`- _(no decodable events)_`);
      } else {
        for (const ev of r.events) {
          lines.push(`- **${ev.name}** @ \`${ev.address}\` — \`${JSON.stringify(ev.args)}\``);
        }
      }
      lines.push('');
    }
  }
  if (f.verification.assertions.length > 0) {
    lines.push(`## Assertions`);
    lines.push('');
    lines.push(`| Status | Severity | Id | Detail |`);
    lines.push(`|---|---|---|---|`);
    for (const a of f.verification.assertions) {
      const mark = a.passed ? '✓' : '✗';
      lines.push(`| ${mark} | ${a.severity} | ${a.id} | ${escapeCell(a.detail)} |`);
    }
    lines.push('');
  }
  if (f.artifacts.tracePath) {
    lines.push(`## Artifacts`);
    lines.push('');
    lines.push(`- Playwright trace: \`trace.zip\` (open with \`npx playwright show-trace trace.zip\`)`);
    if (f.artifacts.screencastPath) {
      lines.push(`- CDP screencast manifest: \`screencast.json\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

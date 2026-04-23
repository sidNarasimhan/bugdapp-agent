/**
 * Drift detector — captures a small structural fingerprint of a dApp's main
 * page(s) and diffs it against a stored baseline. When the fingerprint shifts
 * (new buttons appear, known selectors vanish, routes 404), we re-crawl the
 * affected flows and file a "drift finding" so the human knows the dApp
 * shipped a UI change that may invalidate existing specs.
 *
 * Design choices:
 *   - The snapshot is intentionally small: we collect element counts by role,
 *     a list of visible button names, a list of visible link names, and a hash
 *     of the title. Big enough to spot changes, small enough to commit to
 *     git if someone wants a history.
 *   - The fingerprint is page-local, not site-wide. Each KG page gets its own
 *     snapshot entry keyed by pageId.
 *   - Pure data model — does not own the browser. Callers feed us per-page
 *     snapshots via `addPage()` and we do the diff.
 *
 * The actual browser-driven snapshot capture lives in scripts/watch.ts, which
 * uses playwright-core to navigate and query. That separation keeps this
 * module trivially unit-testable.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

export interface PageSnapshot {
  pageId: string;
  url: string;
  title: string;
  elementCount: number;
  buttons: string[];   // visible button inner-text, deduped + sorted
  links: string[];     // visible link inner-text, deduped + sorted
  inputs: string[];    // visible input/spinbutton accessible-names
  /** 32-bit hash of the combined button + link lists for quick equality checks. */
  fingerprint: number;
  /** When this snapshot was taken. */
  capturedAt: string;
}

export interface Snapshot {
  dapp: string;
  url: string;
  capturedAt: string;
  pages: PageSnapshot[];
}

export interface DriftDiff {
  pageId: string;
  changed: boolean;
  reason: string;
  /** Elements present before but gone now. */
  removedButtons: string[];
  removedLinks: string[];
  addedButtons: string[];
  addedLinks: string[];
  /** Delta in element count (signed). */
  elementCountDelta: number;
  /** Affected flow ids — filled in by the caller using the KG. */
  affectedFlowIds?: string[];
}

export interface DriftReport {
  dapp: string;
  comparedAt: string;
  baselineCapturedAt: string;
  currentCapturedAt: string;
  diffs: DriftDiff[];
  hasDrift: boolean;
}

export function emptySnapshot(dapp: string, url: string): Snapshot {
  return { dapp, url, capturedAt: new Date().toISOString(), pages: [] };
}

export function hashStrings(values: string[]): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    for (let i = 0; i < v.length; i++) {
      h ^= v.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0;
    }
    h ^= 0x7f;
  }
  return h >>> 0;
}

export function normalizeTexts(texts: string[]): string[] {
  const cleaned = texts
    .map(t => t.trim().replace(/\s+/g, ' '))
    .filter(t => t.length > 0 && t.length <= 60);
  return [...new Set(cleaned)].sort();
}

/**
 * Diff two snapshots. Returns a DriftReport; hasDrift is true if any page
 * changed on anything the caller would care about (new/removed elements,
 * element count delta ≥ 10%).
 */
export function diffSnapshots(baseline: Snapshot, current: Snapshot): DriftReport {
  const byId = new Map(baseline.pages.map(p => [p.pageId, p]));
  const diffs: DriftDiff[] = [];

  for (const cur of current.pages) {
    const prev = byId.get(cur.pageId);
    if (!prev) {
      diffs.push({
        pageId: cur.pageId,
        changed: true,
        reason: 'page did not exist in baseline',
        removedButtons: [], removedLinks: [],
        addedButtons: cur.buttons, addedLinks: cur.links,
        elementCountDelta: cur.elementCount,
      });
      continue;
    }
    const removedButtons = prev.buttons.filter(b => !cur.buttons.includes(b));
    const addedButtons = cur.buttons.filter(b => !prev.buttons.includes(b));
    const removedLinks = prev.links.filter(l => !cur.links.includes(l));
    const addedLinks = cur.links.filter(l => !prev.links.includes(l));
    const elementCountDelta = cur.elementCount - prev.elementCount;
    const bigCountShift = prev.elementCount > 0 && Math.abs(elementCountDelta) / prev.elementCount > 0.10;

    const changed = removedButtons.length > 0 || addedButtons.length > 0 ||
      removedLinks.length > 0 || addedLinks.length > 0 || bigCountShift;

    let reason = 'no change';
    if (changed) {
      const parts: string[] = [];
      if (removedButtons.length > 0) parts.push(`${removedButtons.length} button(s) removed`);
      if (addedButtons.length > 0) parts.push(`${addedButtons.length} button(s) added`);
      if (removedLinks.length > 0) parts.push(`${removedLinks.length} link(s) removed`);
      if (addedLinks.length > 0) parts.push(`${addedLinks.length} link(s) added`);
      if (bigCountShift) parts.push(`element count ${elementCountDelta >= 0 ? '+' : ''}${elementCountDelta}`);
      reason = parts.join(', ');
    }

    diffs.push({
      pageId: cur.pageId,
      changed,
      reason,
      removedButtons, removedLinks, addedButtons, addedLinks,
      elementCountDelta,
    });
  }

  const hasDrift = diffs.some(d => d.changed);

  return {
    dapp: baseline.dapp,
    comparedAt: new Date().toISOString(),
    baselineCapturedAt: baseline.capturedAt,
    currentCapturedAt: current.capturedAt,
    diffs,
    hasDrift,
  };
}

/**
 * Attach KG-flow information to each drift diff. A flow is marked "affected"
 * if any of its step selectors references a button/link that was removed or
 * added, or if its page is in the drift set. The caller then knows which
 * specs to re-run or regenerate.
 */
export function annotateAffectedFlows(
  report: DriftReport,
  kg: { flows: Array<{ id: string; pageId: string; steps: Array<{ selector?: string; description: string }> }> },
): DriftReport {
  for (const diff of report.diffs) {
    if (!diff.changed) continue;
    const affected = new Set<string>();
    for (const flow of kg.flows) {
      if (flow.pageId === diff.pageId) {
        affected.add(flow.id);
        continue;
      }
      for (const step of flow.steps) {
        const txt = (step.selector ?? '') + ' ' + (step.description ?? '');
        for (const name of [...diff.removedButtons, ...diff.removedLinks]) {
          if (name && txt.includes(name)) { affected.add(flow.id); break; }
        }
      }
    }
    diff.affectedFlowIds = [...affected];
  }
  return report;
}

// ── Disk layout helpers ──

function driftDir(projectRoot: string, dappHost: string): string {
  return join(projectRoot, 'output', dappHost, 'drift');
}

export function saveBaseline(projectRoot: string, dappHost: string, snapshot: Snapshot): string {
  const dir = driftDir(projectRoot, dappHost);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'baseline.json');
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  return path;
}

export function loadBaseline(projectRoot: string, dappHost: string): Snapshot | null {
  const path = join(driftDir(projectRoot, dappHost), 'baseline.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}

export function saveReport(projectRoot: string, dappHost: string, report: DriftReport): string {
  const dir = driftDir(projectRoot, dappHost);
  mkdirSync(dir, { recursive: true });
  const day = report.comparedAt.replace(/[:.]/g, '-');
  const path = join(dir, `report-${day}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

/**
 * Append a line to the dApp's findings feed — a rolling JSONL log of notable
 * events (drift detected, scenario failed, invariant violated) that the
 * Discord bot / dashboard can tail.
 */
export function appendFeed(projectRoot: string, dappHost: string, entry: Record<string, unknown>): string {
  const dir = join(projectRoot, 'output', dappHost, 'findings');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'feed.jsonl');
  appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  return path;
}

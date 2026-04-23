/**
 * Gap Analysis — analyzes crawler output and produces a targeted brief for the explorer.
 * Detects generic patterns (forms, dropdowns, toggles, coverage gaps) without
 * hardcoding any dApp-specific knowledge.
 */

import type { PageScrapedData, InteractionRecord, DiscoveredFlow, CoverageMap } from './context.js';
import type { ContextData } from '../types.js';

// ── Exported Interfaces ──

export interface ExplorerBrief {
  /** Flows the explorer should execute — each is a multi-step user journey */
  targetedFlows: TargetedFlow[];
  /** Per-page summary of what was covered and what wasn't */
  pageSummaries: PageSummary[];
  /** Total estimated tool calls needed */
  estimatedBudget: number;
}

export interface TargetedFlow {
  id: string;
  name: string;
  /** Which page to start on */
  startPage: string;
  /** Priority 1-3 (1=critical) */
  priority: number;
  /** Why this flow needs exploration */
  reason: string;
  /** Concrete steps the explorer should take */
  steps: string[];
  /** What to verify/assert after the flow */
  expectedOutcome: string;
  /** Estimated tool calls */
  estimatedCalls: number;
}

export interface PageSummary {
  path: string;
  elementsTotal: number;
  elementsCovered: number;
  /** Elements that had meaningful state changes when interacted with */
  meaningfulElements: string[];
  /** Elements that were skipped or had no effect */
  lowValueElements: string[];
  /** What the crawler found on this page */
  discoveredBehaviors: string[];
}

// ── Patterns ──

const SUBMIT_PATTERN = /submit|confirm|place|open|close|swap|deposit|withdraw|stake|enable|approve/i;
const INPUT_ROLES = new Set(['spinbutton', 'textbox']);
const TOGGLE_ROLES = new Set(['switch', 'checkbox']);

// ── Helpers ──

let flowIdCounter = 0;
function nextFlowId(): string {
  return `flow-${++flowIdCounter}`;
}

function estimateCalls(steps: string[]): number {
  return 2 + steps.length * 2;
}

function makeFlow(
  partial: Omit<TargetedFlow, 'id' | 'estimatedCalls'>,
): TargetedFlow {
  return {
    id: nextFlowId(),
    estimatedCalls: estimateCalls(partial.steps),
    ...partial,
  };
}

// ── Flow Detectors ──

function detectFormFlows(
  path: string,
  data: PageScrapedData,
): TargetedFlow[] {
  const inputs = data.elements.filter(e => INPUT_ROLES.has(e.role));
  const submitButtons = data.elements.filter(
    e => e.role === 'button' && !e.disabled && SUBMIT_PATTERN.test(e.name),
  );

  if (inputs.length === 0 || submitButtons.length === 0) return [];

  return submitButtons.map(btn => {
    const steps = [
      ...inputs.map(inp => `Fill "${inp.name}" (${inp.role}) with a test value`),
      `Click "${btn.name}" button`,
      'Wait for response / state change',
    ];

    return makeFlow({
      name: `Submit form via "${btn.name}" on ${path}`,
      startPage: path,
      priority: 1,
      reason: `Page has ${inputs.length} input(s) and a submit-like button "${btn.name}"`,
      steps,
      expectedOutcome: 'Form submits successfully or shows a meaningful validation/error message',
    });
  });
}

function detectDropdownFlows(
  path: string,
  data: PageScrapedData,
): TargetedFlow[] {
  const flows: TargetedFlow[] = [];

  for (const [dropdownName, options] of Object.entries(data.dropdownContents)) {
    if (options.length < 2) continue;

    // Pick up to 3 interesting options (first, middle, last)
    const picks: string[] = [];
    picks.push(options[0]);
    if (options.length > 2) picks.push(options[Math.floor(options.length / 2)]);
    picks.push(options[options.length - 1]);

    for (const option of picks) {
      flows.push(makeFlow({
        name: `Select "${option}" from "${dropdownName}" on ${path}`,
        startPage: path,
        priority: 1,
        reason: `Dropdown "${dropdownName}" has ${options.length} options — verifying selection side-effects`,
        steps: [
          `Open dropdown "${dropdownName}"`,
          `Select option "${option}"`,
          'Snapshot the page to verify state changed',
        ],
        expectedOutcome: 'Page state updates to reflect the selected option (chart, form, display)',
      }));
    }
  }

  return flows;
}

function detectToggleFlows(
  path: string,
  data: PageScrapedData,
): TargetedFlow[] {
  const toggles = data.elements.filter(e => TOGGLE_ROLES.has(e.role));
  if (toggles.length === 0) return [];

  const flows: TargetedFlow[] = [];

  // Individual toggle tests
  for (const toggle of toggles) {
    flows.push(makeFlow({
      name: `Toggle "${toggle.name}" on ${path}`,
      startPage: path,
      priority: 1,
      reason: `Toggle "${toggle.name}" needs state verification`,
      steps: [
        `Click toggle/switch "${toggle.name}" to change its state`,
        'Snapshot and verify page state changed',
      ],
      expectedOutcome: `Toggle "${toggle.name}" changes state and the page reflects the new setting`,
    }));
  }

  // One combination flow if multiple toggles
  if (toggles.length >= 2) {
    const steps = toggles.slice(0, 3).flatMap(t => [
      `Toggle "${t.name}" on`,
      'Snapshot to verify combined state',
    ]);

    flows.push(makeFlow({
      name: `Combined toggles on ${path}`,
      startPage: path,
      priority: 2,
      reason: `${toggles.length} toggles found — testing combined state`,
      steps,
      expectedOutcome: 'All toggled settings apply simultaneously without conflicts',
    }));
  }

  return flows;
}

function detectCoverageGapFlows(
  coverageMap: CoverageMap,
  scrapedData: Record<string, PageScrapedData>,
): TargetedFlow[] {
  const flows: TargetedFlow[] = [];

  for (const gap of coverageMap.interactionSummary.coverageGaps) {
    const gapLower = gap.toLowerCase();

    // Determine which page this gap relates to
    let page = Object.keys(scrapedData)[0] ?? '/';
    for (const p of coverageMap.pages) {
      if (gap.includes(p.path)) {
        page = p.path;
        break;
      }
    }

    const steps: string[] = [];
    let expectedOutcome = 'The gap in coverage is addressed and the resulting state is verified';

    if (gapLower.includes('selector') && gapLower.includes('no') && gapLower.includes('select')) {
      steps.push('Open the asset/item selector');
      steps.push('Select the first available option');
      steps.push('Verify the page updates accordingly');
      expectedOutcome = 'Selection is applied and downstream UI reflects the choice';
    } else if (gapLower.includes('input') && gapLower.includes('no') && gapLower.includes('submit')) {
      steps.push('Fill input fields with valid test values');
      steps.push('Click the submit/confirm button');
      steps.push('Verify form submission result');
      expectedOutcome = 'Form submits and produces a result or validation message';
    } else {
      // Generic gap handling
      steps.push(`Investigate: ${gap}`);
      steps.push('Interact with the relevant element');
      steps.push('Verify resulting state change');
    }

    flows.push(makeFlow({
      name: `Coverage gap: ${gap.slice(0, 60)}`,
      startPage: page,
      priority: 2,
      reason: `Crawler identified gap: "${gap}"`,
      steps,
      expectedOutcome,
    }));
  }

  return flows;
}

function detectCrossPageFlows(
  scrapedData: Record<string, PageScrapedData>,
): TargetedFlow[] {
  const pages = Object.entries(scrapedData);
  if (pages.length < 2) return [];

  const flows: TargetedFlow[] = [];

  // Find pages with forms (inputs+buttons) and pages that might show results
  const pagesWithForms = pages.filter(([, d]) =>
    d.elements.some(e => INPUT_ROLES.has(e.role)) &&
    d.elements.some(e => e.role === 'button' && !e.disabled && SUBMIT_PATTERN.test(e.name)),
  );

  for (const [formPage, formData] of pagesWithForms) {
    const otherPages = pages.filter(([p]) => p !== formPage);
    if (otherPages.length === 0) continue;

    const submitBtn = formData.elements.find(
      e => e.role === 'button' && !e.disabled && SUBMIT_PATTERN.test(e.name),
    );
    const targetPage = otherPages[0][0];

    flows.push(makeFlow({
      name: `Cross-page: submit on ${formPage} → verify on ${targetPage}`,
      startPage: formPage,
      priority: 2,
      reason: `Form on ${formPage} may produce results visible on ${targetPage}`,
      steps: [
        `Fill form inputs on ${formPage}`,
        `Click "${submitBtn?.name ?? 'submit'}"`,
        `Navigate to ${targetPage}`,
        'Verify the action result is reflected',
      ],
      expectedOutcome: 'Action on the first page is reflected on the second page',
    }));
  }

  return flows;
}

function detectErrorStateFlows(
  path: string,
  data: PageScrapedData,
): TargetedFlow[] {
  const inputs = data.elements.filter(e => INPUT_ROLES.has(e.role));
  const submitButtons = data.elements.filter(
    e => e.role === 'button' && !e.disabled && SUBMIT_PATTERN.test(e.name),
  );

  if (inputs.length === 0 || submitButtons.length === 0) return [];

  const btn = submitButtons[0];
  const flows: TargetedFlow[] = [];

  // Zero value test
  flows.push(makeFlow({
    name: `Error: zero values on ${path}`,
    startPage: path,
    priority: 2,
    reason: 'Test error handling with zero/empty input values',
    steps: [
      ...inputs.map(inp => `Fill "${inp.name}" with "0"`),
      `Click "${btn.name}"`,
      'Verify error message or disabled state',
    ],
    expectedOutcome: 'Application shows appropriate error or prevents submission',
  }));

  // Large value test
  flows.push(makeFlow({
    name: `Error: large values on ${path}`,
    startPage: path,
    priority: 2,
    reason: 'Test error handling with extremely large input values',
    steps: [
      ...inputs.map(inp => `Fill "${inp.name}" with "999999999999"`),
      `Click "${btn.name}"`,
      'Verify error handling for excessive values',
    ],
    expectedOutcome: 'Application shows appropriate error (insufficient balance, max exceeded, etc.)',
  }));

  // Empty submit test
  flows.push(makeFlow({
    name: `Error: empty submit on ${path}`,
    startPage: path,
    priority: 3,
    reason: 'Test submitting without filling required inputs',
    steps: [
      `Click "${btn.name}" without filling any inputs`,
      'Verify validation message or disabled state',
    ],
    expectedOutcome: 'Application prevents submission or shows validation errors',
  }));

  return flows;
}

// ── Page Summaries ──

function buildPageSummaries(
  scrapedData: Record<string, PageScrapedData>,
  interactions: InteractionRecord[],
  coverageMap: CoverageMap,
): PageSummary[] {
  return coverageMap.pages.map(page => {
    const pageInteractions = interactions.filter(i => i.page === page.path);
    const data = scrapedData[page.path];

    const meaningfulElements: string[] = [];
    const lowValueElements: string[] = [];

    for (const el of page.uniqueElements) {
      const label = `${el.role}:${el.name}`;
      if (el.interacted && el.resultSummary && el.resultSummary !== 'no change') {
        meaningfulElements.push(label);
      } else {
        lowValueElements.push(label);
      }
    }

    const discoveredBehaviors: string[] = [];
    for (const interaction of pageInteractions) {
      if (interaction.domChanges.appeared.length > 0 || interaction.domChanges.changed.length > 0) {
        discoveredBehaviors.push(
          `${interaction.action} on "${interaction.elementName}" → ` +
          `${interaction.domChanges.appeared.length} appeared, ${interaction.domChanges.changed.length} changed`,
        );
      }
    }

    if (data) {
      for (const [name, options] of Object.entries(data.dropdownContents)) {
        discoveredBehaviors.push(`Dropdown "${name}" with ${options.length} options`);
      }
    }

    return {
      path: page.path,
      elementsTotal: page.elementsTotal,
      elementsCovered: page.elementsInteracted,
      meaningfulElements,
      lowValueElements,
      discoveredBehaviors,
    };
  });
}

// ── Budget Trimming ──

function trimToBudget(flows: TargetedFlow[], maxBudget: number): TargetedFlow[] {
  // Sort by priority (ascending) then by estimated calls (ascending)
  const sorted = [...flows].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.estimatedCalls - b.estimatedCalls;
  });

  const kept: TargetedFlow[] = [];
  let total = 0;

  for (const flow of sorted) {
    if (total + flow.estimatedCalls > maxBudget) continue;
    kept.push(flow);
    total += flow.estimatedCalls;
  }

  return kept;
}

// ── Main Export ──

export function buildExplorerBrief(
  scrapedData: Record<string, PageScrapedData>,
  interactions: InteractionRecord[],
  discoveredFlows: DiscoveredFlow[],
  coverageMap: CoverageMap,
  context: ContextData,
): ExplorerBrief {
  // Reset ID counter for deterministic output
  flowIdCounter = 0;

  const allFlows: TargetedFlow[] = [];

  // Per-page flow detection
  for (const [path, data] of Object.entries(scrapedData)) {
    allFlows.push(...detectFormFlows(path, data));
    allFlows.push(...detectDropdownFlows(path, data));
    allFlows.push(...detectToggleFlows(path, data));
    allFlows.push(...detectErrorStateFlows(path, data));
  }

  // Cross-cutting detectors
  allFlows.push(...detectCoverageGapFlows(coverageMap, scrapedData));
  allFlows.push(...detectCrossPageFlows(scrapedData));

  // Trim to budget (~50 calls)
  const MAX_BUDGET = 50;
  const targetedFlows = trimToBudget(allFlows, MAX_BUDGET);

  const pageSummaries = buildPageSummaries(scrapedData, interactions, coverageMap);

  const estimatedBudget = targetedFlows.reduce((sum, f) => sum + f.estimatedCalls, 0);

  return {
    targetedFlows,
    pageSummaries,
    estimatedBudget,
  };
}

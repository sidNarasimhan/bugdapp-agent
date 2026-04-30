import type { Page, BrowserContext as PlaywrightContext } from 'playwright-core';

// ── Browser Context ──

export interface SnapshotRef {
  role: string;
  name: string;
  testId?: string;
  tag?: string;
  type?: string;
  disabled?: boolean;
}

export interface BrowserCtx {
  page: Page;
  context: PlaywrightContext;
  extensionId?: string;
  snapshotRefs: Map<string, SnapshotRef>;
  screenshotDir: string;
  screenshotCounter: number;
}

// ── Tool Definitions ──

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCallResult {
  success: boolean;
  output: string;
}

// ── Phase Outputs ──

export interface ContextData {
  url: string;
  title: string;
  description: string;
  docsContent: string;
  chain?: string;
  features: string[];
}

export interface PageDiscovery {
  url: string;
  name: string;
  snapshot: string;
  screenshotPath?: string;
  interactiveElements: SnapshotRef[];
  walletRequired: boolean;
  web3Elements?: { type: string; text: string }[];
}

// ── Archetype + UI state types (formerly in src/agent/profiles/types.ts) ──

export type ArchetypeName = 'perps' | 'swap' | 'lending' | 'staking' | 'cdp' | 'yield' | 'lp' | 'bridge';

/** Per-archetype defaults — each archetype can derive these from comprehension/KG at runtime. */
export interface ValueConfig {
  minPositionSizeUsd?: number;
  targetLeverage?: number | null;
  preferredAmountUsd?: number;
  slippageBps?: number;
}

/** Terminal states a form can reach after filling. */
export type TerminalState =
  | 'ready-to-action'
  | 'needs-approval'
  | 'wrong-network'
  | 'unfunded'
  | 'unconnected'
  | 'min-amount'
  | 'max-amount'
  | 'unknown';

export interface ClassifiedCta {
  state: TerminalState;
  ctaText: string;
  ctaDisabled: boolean;
}

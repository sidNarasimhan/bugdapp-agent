import type { Page, BrowserContext as PlaywrightContext } from 'playwright-core';

// ── Config ──

export interface QAConfig {
  url: string;
  seedPhrase: string;
  apiKey: string;
  outputDir: string;
  headless: boolean;
  cdpUrl?: string;
  docsUrl?: string;
  metamaskPath?: string;

  explorerModel: string;
  plannerModel: string;
  generatorModel: string;
  healerModel: string;

  maxExplorerCalls: number;
  maxHealAttempts: number;
  skipExecute: boolean;
  stopAfter?: 'context' | 'explore' | 'plan' | 'generate';
  skipContext?: boolean;
  skipExplore?: boolean;
}

export const DEFAULT_CONFIG: Partial<QAConfig> = {
  headless: false,
  explorerModel: 'anthropic/claude-sonnet-4',
  plannerModel: 'anthropic/claude-sonnet-4',
  generatorModel: 'anthropic/claude-sonnet-4',
  healerModel: 'anthropic/claude-sonnet-4',
  maxExplorerCalls: 60,
  maxHealAttempts: 2,
};

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
  controlSignal?: ControlSignal;
}

export type ControlSignal =
  | { type: 'exploration_complete'; summary: string; data: ExplorationResult }
  | { type: 'step_complete'; summary: string }
  | { type: 'step_failed'; error: string };

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

export interface ExplorationResult {
  pages: PageDiscovery[];
  connectedState: {
    address: string;
    network: string;
    chainId: string;
  } | null;
  connectFlow: string[];
  navigationLinks: string[];
  modules?: any[];
  tradingAssets?: string[];
  graph?: SerializedGraph;
}

// ── State Graph ──

export interface StateNode {
  hash: string;
  url: string;
  pageTitle: string;
  elements: { ref: string; role: string; name: string; tag?: string }[];
  walletConnected: boolean;
  activeModal: string | null;
  formState: Record<string, string>;
  screenshotPath?: string;
  snapshotText?: string;
  visitCount: number;
}

export interface StateEdge {
  id: string;
  fromHash: string;
  toHash: string;
  action: {
    type: 'click' | 'type' | 'navigate' | 'press_key' | 'scroll' | 'wallet_approve' | 'wallet_sign' | 'wallet_confirm' | 'wallet_reject' | 'wallet_switch_network';
    target?: string;
    value?: string;
  };
  success: boolean;
  sideEffects: string[];
  timestamp: number;
}

export interface SerializedGraph {
  nodes: StateNode[];
  edges: StateEdge[];
  rootHash: string | null;
}

export interface TestCase {
  id: string;
  title: string;
  category: string;
  steps: string[];
  expectedOutcome: string;
  requiresFundedWallet: boolean;
  parameterizable: boolean;
  parameters?: Record<string, string[]>;
}

export interface TestPlan {
  dappName: string;
  dappUrl: string;
  suites: {
    name: string;
    description: string;
    tests: TestCase[];
  }[];
}

export interface TestResult {
  testId: string;
  title: string;
  status: 'passed' | 'failed' | 'skipped';
  error?: string;
  durationMs: number;
  screenshotPath?: string;
}

export interface QAReport {
  dappUrl: string;
  dappName: string;
  timestamp: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  results: TestResult[];
  costUsd: number;
  durationMs: number;
  explorationSummary: string;
  bugsFound: string[];
}

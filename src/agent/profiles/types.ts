/**
 * DAppProfile — per-dApp configuration that captures the quirks of each target dApp.
 *
 * The pipeline's generic core (crawler, kg-builder, flow-computer, spec-generator,
 * executor, fixture) never hardcodes dApp-specific constants. Every dApp-specific
 * value — network, min amounts, CTA verbs, inverse flow routes — lives in a profile.
 *
 * Scaling to the top 10×10 dApps/chains means writing one profile per dApp (~2-3 hrs
 * after the first few), not touching the core. Archetypes (perps, swap, lending, etc.)
 * provide the category-level logic that profiles plug into.
 */

export type Chain =
  | 'ethereum'
  | 'base'
  | 'arbitrum'
  | 'optimism'
  | 'polygon'
  | 'bnb'
  | 'avalanche'
  | 'linea'
  | 'blast'
  | 'scroll';

export interface NetworkConfig {
  chain: Chain;
  chainId: number;
  chainHexId: string; // e.g. '0x2105' for Base
  rpcUrl: string;
  blockExplorerUrl: string;
  nativeCurrency: { symbol: string; decimals: number };
  // What the dApp's own "Switch to X" button looks like — regex matched against button text
  switchCtaPattern: RegExp;
}

export type ArchetypeName = 'perps' | 'swap' | 'lending' | 'staking' | 'cdp' | 'yield' | 'lp' | 'bridge';

/** Per-archetype value defaults — each archetype knows how to calculate these from constraints. */
export interface ValueConfig {
  /** Avantis has $500 min position, Aave has dust-level mins, Uniswap has no explicit min */
  minPositionSizeUsd?: number;
  /** Target leverage (perps only). Null = not leveraged. */
  targetLeverage?: number | null;
  /** Preferred collateral/amount in USD units (unscaled, human-readable) */
  preferredAmountUsd?: number;
  /** Slippage tolerance for swap archetype, in basis points (100 = 1%) */
  slippageBps?: number;
}

/**
 * Hints that help the crawler and spec-generator find the right UI elements on this dApp.
 * Every field is optional — if missing, the archetype-level defaults apply.
 */
export interface SelectorHints {
  /**
   * CTA tier patterns in priority order. Each tier is a list of button-name regexes.
   * spec-generator walks tiers top-to-bottom and picks the first visible match.
   */
  ctaTiers?: RegExp[];
  /** Pattern to detect the asset/token selector opener button */
  assetSelectorPattern?: RegExp;
  /** Pattern to detect the "primary form" region when scoping clicks */
  formPanelSelector?: string;
  /** Selector for the top-level navigation that should be EXCLUDED from CTA search */
  navExcludeSelector?: string;
  /** Wallet-connect modal quirks — see ConnectHints */
  connect?: ConnectHints;
}

/**
 * Per-dApp quirks for the wallet-connect flow.
 * Examples:
 *   - Uniswap hides MetaMask behind an "Other wallets" expander
 *   - Some dApps have a "Use embedded wallet" option that must be skipped
 *   - RainbowKit vs Privy vs Wagmi each have slightly different modal structures
 */
export interface ConnectHints {
  /**
   * Text/patterns to click BEFORE looking for the MetaMask option — used to expand
   * hidden wallet lists. Clicks are fire-and-forget: missing elements don't fail.
   */
  preMetaMaskClicks?: Array<string | RegExp>;
  /** Override the default Login/Connect button pattern if the dApp uses unusual label */
  loginButtonPattern?: RegExp;
  /** data-testid for the Connect button, if the dApp exposes one (more stable than text) */
  loginButtonTestId?: string;
}

/**
 * Inverse flows — for every "create" flow the dApp has, what undoes it.
 * Used to generate open→close, supply→withdraw, deposit→repay test pairs
 * and to clean up test wallet state between runs.
 */
export interface InverseFlow {
  /** Human-readable name, e.g. "close position" */
  name: string;
  /** Route on the dApp where this action lives, relative to the dApp origin, e.g. "/portfolio" */
  route: string;
  /** Pattern for the "undo" button on the inverse page */
  ctaPattern: RegExp;
  /** Optional secondary-confirm button pattern for modal flows */
  confirmPattern?: RegExp;
}

export interface DAppProfile {
  /** Human-readable name (used in logs, reports, demo videos) */
  name: string;
  /** Match URLs this profile applies to — can be string equality, hostname, or regex */
  urlMatches: Array<string | RegExp>;
  /** The dApp's canonical entry URL (what the spec uses as DAPP_URL) */
  url: string;
  /** Which archetype module handles this dApp */
  archetype: ArchetypeName;
  /** Chain + RPC + native currency configuration */
  network: NetworkConfig;
  /** Default values for trade/supply/swap amounts */
  values: ValueConfig;
  /** Optional selector overrides — most profiles won't need these */
  selectors?: SelectorHints;
  /** Inverse flows (close/withdraw/repay) for cleanup + open→close test pairs */
  inverseFlows?: InverseFlow[];
  /** Notes for future maintainers about this dApp's quirks */
  notes?: string;
}

/** Terminal states a form can reach after filling. Used by the state classifier. */
export type TerminalState =
  | 'ready-to-action'  // Primary CTA is visible + enabled — we can click and submit
  | 'needs-approval'   // Token approval required first (Approve USDC, etc.)
  | 'wrong-network'    // Wallet on wrong chain
  | 'unfunded'         // Insufficient balance to execute
  | 'unconnected'      // Wallet not connected
  | 'min-amount'       // Input below minimum
  | 'max-amount'       // Input above maximum
  | 'unknown';         // Couldn't classify — treated as test failure

export interface ClassifiedCta {
  state: TerminalState;
  ctaText: string;
  ctaDisabled: boolean;
}

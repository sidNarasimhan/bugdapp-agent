// KG types. No LangGraph dependency — pipeline state is plain interface below.
import { z } from 'zod';

// ── Knowledge Graph Node Types ──

export interface KGPage {
  id: string;
  url: string;
  name: string;
  title: string;
  elementCount: number;
  walletRequired: boolean;
}

export interface KGComponent {
  id: string;
  pageId: string;
  role: string;         // button, input, switch, tab, combobox, slider
  name: string;
  selector: string;     // Playwright selector (getByRole, getByText, etc.)
  testId?: string;
  disabled: boolean;
  dynamic: boolean;     // true if content changes (prices, balances)
}

export interface KGAction {
  id: string;
  componentId: string;
  type: 'click' | 'type' | 'toggle' | 'select' | 'drag' | 'scroll';
  value?: string;       // for type/select actions
  resultDescription: string;
  newElementsAppeared: string[];
  elementsDisappeared: string[];
  triggersWallet: boolean;
  success: boolean;
}

export interface KGFlow {
  id: string;
  name: string;         // e.g. "Place BTC-USD Long Market Order"
  description: string;
  pageId: string;
  steps: KGFlowStep[];
  requiresFundedWallet: boolean;
  category: string;     // trading, navigation, portfolio, earn, wallet, error
  priority: number;     // 1=critical, 2=important, 3=nice-to-have
  tested: boolean;
  testResult?: 'pass' | 'fail' | 'untested';
}

export interface KGFlowStep {
  order: number;
  actionId?: string;
  description: string;
  expectedOutcome: string;
  selector?: string;
}

export interface KGEdgeCase {
  id: string;
  flowId: string;
  name: string;         // e.g. "Zero collateral", "Max leverage", "Wrong network"
  description: string;
  inputValue?: string;
  expectedBehavior: string;
  tested: boolean;
  testResult?: 'pass' | 'fail' | 'untested';
}

export interface KGTestCase {
  id: string;
  flowId?: string;
  edgeCaseId?: string;
  name: string;
  specFile?: string;
  specCode?: string;
  status: 'planned' | 'generated' | 'pass' | 'fail' | 'healed';
  error?: string;
  attempts: number;
}

export interface KGEdge {
  from: string;         // source node id
  to: string;           // target node id
  relationship: string; // 'contains' | 'triggers' | 'requires' | 'navigatesTo' | 'tests' | 'partOf'
}

// ── Rich Context Nodes (from docs, APIs, dropdowns) ──

export interface KGFeature {
  id: string;
  name: string;         // e.g. "Zero Fee Perpetuals", "Guaranteed TP/SL"
  description: string;  // from docs
  pageId?: string;
  constraints?: string; // e.g. "min 75x leverage, crypto majors + memes only"
}

export interface KGAsset {
  id: string;
  symbol: string;       // e.g. "BTC-USD", "EUR-USD"
  group: string;        // e.g. "Crypto", "Forex", "Commodities"
  maxLeverage?: number;
  minCollateral?: number;
  tradingHours?: string;
}

export interface KGDropdownOption {
  id: string;
  componentId: string;  // which dropdown component
  value: string;        // the option text
  index: number;
}

export interface KGDocSection {
  id: string;
  title: string;
  content: string;      // trimmed text
  keywords: string[];   // extracted keywords
}

export interface KGApiEndpoint {
  id: string;
  path: string;
  description: string;  // what the response contains
  sampleKeys: string[]; // top-level keys from response
}

export interface KGConstraint {
  id: string;
  name: string;           // e.g. "Max leverage", "Liquidation threshold"
  value: string;          // e.g. "500x", "80% collateral health"
  scope?: string;         // e.g. "ZFP only", "Forex pairs", "all assets"
  testImplication: string; // e.g. "Test placing order at 501x leverage — should be rejected"
  source: string;         // where this was found: "docs", "api", "explorer"
}

export interface KGContract {
  id: string;
  address: string;        // 0x + 40 hex, lowercase
  chainId?: number;       // best-guess chain from source context, if known
  name?: string;          // if verified by etherscan
  role?: string;          // router | token | pool | oracle | factory | lending | other
  source: 'docs' | 'network' | 'bundle' | 'profile';
  verified?: boolean;     // true if Etherscan confirms source code is verified
}

export interface KnowledgeGraph {
  pages: KGPage[];
  components: KGComponent[];
  actions: KGAction[];
  flows: KGFlow[];
  edgeCases: KGEdgeCase[];
  testCases: KGTestCase[];
  edges: KGEdge[];
  features: KGFeature[];
  assets: KGAsset[];
  dropdownOptions: KGDropdownOption[];
  docSections: KGDocSection[];
  apiEndpoints: KGApiEndpoint[];
  constraints: KGConstraint[];
  contracts: KGContract[];
}

export function emptyKnowledgeGraph(): KnowledgeGraph {
  return {
    pages: [], components: [], actions: [], flows: [], edgeCases: [],
    testCases: [], edges: [], features: [], assets: [], dropdownOptions: [],
    docSections: [], apiEndpoints: [], constraints: [], contracts: [],
  };
}

function mergeKG(existing: KnowledgeGraph, update: KnowledgeGraph): KnowledgeGraph {
  const mergeById = <T extends { id: string }>(a: T[], b: T[]): T[] => {
    const map = new Map(a.map(x => [x.id, x]));
    for (const item of b) map.set(item.id, item);
    return [...map.values()];
  };
  return {
    pages: mergeById(existing.pages, update.pages),
    components: mergeById(existing.components, update.components),
    actions: mergeById(existing.actions, update.actions),
    flows: mergeById(existing.flows, update.flows),
    edgeCases: mergeById(existing.edgeCases, update.edgeCases),
    testCases: mergeById(existing.testCases, update.testCases),
    features: mergeById(existing.features, update.features),
    assets: mergeById(existing.assets, update.assets),
    dropdownOptions: mergeById(existing.dropdownOptions, update.dropdownOptions),
    docSections: mergeById(existing.docSections, update.docSections),
    apiEndpoints: mergeById(existing.apiEndpoints, update.apiEndpoints),
    constraints: mergeById(existing.constraints, update.constraints),
    contracts: mergeById(existing.contracts ?? [], update.contracts ?? []),
    edges: [...existing.edges, ...update.edges.filter(e =>
      !existing.edges.some(x => x.from === e.from && x.to === e.to && x.relationship === e.relationship)
    )],
  };
}

// ── Capability-centric data model (rebuild from user feedback) ──
//
// Hierarchy: dApp → Page → Module (kind=primary|cross-cutting|shared)
//            → Capability (atomic user goal, DERIVED from graph traversal)
//            → Control (semantic UI cluster) → Component (DOM atom).
//
// Flows are not invented by an LLM — they're graph paths from any control
// to a SubmitCTA, enumerated by src/pipeline/capability-derivation.ts.
// The LLM only clusters DOM atoms into Controls, infers control edges,
// discovers modules, and labels capabilities. No flow invention.

/** A top-level module can be primary (page-specific user area), cross-cutting
 *  (appears on every page — nav, wallet), or shared (referenced from multiple
 *  modules, e.g. an asset selector that both Trade and Portfolio use). */
export type ModuleKind = 'primary' | 'cross-cutting' | 'shared';

/** Cross-module edges — captures dApp topology. */
export interface ModuleRelation {
  /** depends_on — module's capabilities require another module first. */
  dependsOn?: string[];
  /** produces an entity (Trade produces Position). */
  produces?: Array<{ entity: string; consumedBy: string[] }>;
  /** consumed_by — module reads/operates on entities from another module. */
  consumedBy?: Array<{ entity: string; producedBy: string[] }>;
  /** navigates_to — this module has controls that open other modules. */
  navigatesTo?: string[];
  /** cross_refs — soft reference (Referral links to Trade). */
  crossRefs?: string[];
}

export interface DAppModule {
  id: string;
  name: string;
  kind: ModuleKind;
  description: string;
  businessPurpose: string;
  archetype?: string;
  /** Pages that host this module (many-to-many — cross-cutting modules are on every page). */
  pageIds: string[];
  /** DOM components that physically belong to this module (before clustering into Controls). */
  componentIds: string[];
  /** Semantic controls within this module (produced by Control Clustering). */
  controlIds: string[];
  /** Doc section ids that explain this module. */
  docSectionIds: string[];
  /** API endpoint paths this module hits. */
  apiEndpointIds: string[];
  /** Contract addresses this module interacts with. */
  contractAddresses: string[];
  /** Constraint ids that apply to this module. */
  constraintIds: string[];
  /** Cross-module topology edges. */
  relations: ModuleRelation;
  /** Legacy — kept for back-compat during transition. */
  parentId?: string;
  triggeredByComponentIds?: string[];
  subModules?: DAppModule[];
}

// ── Control (semantic UI cluster — clusters DOM atoms) ──

/** Semantic roles a Control can play. */
export type ControlKind =
  | 'input'              // free-form text/number input
  | 'toggle'             // on/off switch
  | 'radio'              // mutually exclusive options (Long/Short)
  | 'tabs'               // mutually exclusive tabs (Market/Limit/Stop)
  | 'percentage-picker'  // 10/25/50/75/100% buttons
  | 'slider'             // range input (leverage)
  | 'dropdown'           // select from list
  | 'modal-selector'     // opens a modal with a picker (asset selector)
  | 'submit-cta'         // the primary submit/action button
  | 'link'               // navigation link
  | 'tab'                // passive tab (view switcher, no form state)
  | 'button';            // generic button (reveals modal, triggers side effect)

export interface Control {
  id: string;
  moduleId: string;
  name: string;                 // human-readable label ('Collateral Quick-Pick')
  kind: ControlKind;
  /** DOM components clustered under this control. */
  componentIds: string[];
  /** For multi-option controls: the option labels. */
  options?: string[];
  /** Unit (USDC, x, %, ETH…). */
  unit?: string;
  /** Free-form description of what user picks/enters. */
  description: string;
  // Wiring (produced by Control Wiring phase)
  /** Controls this feeds data into (config → submit). */
  feedsInto: string[];
  /** Controls this gates (toggle → leverage). */
  gates: string[];
  /** Inverse of gates. */
  affectedBy: string[];
  /** If this is a reveal trigger, which module it opens. */
  revealsModuleId?: string;
  /** If this is a submit-cta, which capability it completes. */
  submitsFor?: string[];
}

// ── Capability (atomic testable user goal) ──

export interface CapabilityEdgeCase {
  id: string;
  name: string;
  /** Which control is varied. */
  controlId: string;
  /** Invalid/boundary value. */
  invalidValue: string;
  /** Expected rejection text / terminal state. */
  expectedRejection: string;
  /** Constraint that generated this edge case. */
  constraintId: string;
  /** If set, edge case only applies to test rows whose asset is in this class
   *  (e.g. 'commodity', 'fx'). null/undefined = applies to all rows. Used by
   *  spec-gen to gate per-row edge cases: WTI row gets commodity-max-leverage,
   *  BTC row gets crypto-max-leverage, not both. */
  appliesToAssetClass?: string;
}

export interface Capability {
  id: string;
  moduleId: string;
  /** LLM-generated display name ('Open ZFP Long on ETH-USD'). */
  name: string;
  /** User's goal. */
  intent: string;
  /** Preconditions derived from module.relations.dependsOn + constraints. */
  preconditions: string[];
  /** Controls traversed, in order (first → last, ending with submit-cta). */
  controlPath: string[];
  /** Option selections per control ({controlId: 'Long', …}). */
  optionChoices: Record<string, string>;
  /** Doc sections cited. */
  docIds: string[];
  /** Constraints enforced in this capability. */
  constraintIds: string[];
  /** What user verifies after. */
  successCriteria: string;
  /** Personas most relevant (LLM-tagged). */
  personas: string[];
  /** Boundary / invalid / adversarial variants. */
  edgeCases: CapabilityEdgeCase[];
  /** Archetype inherited from module. */
  archetype?: string;
  /** Risk class. */
  riskClass: 'safe' | 'medium' | 'high';
}

// ── Constraints (first-class, structured from docs + crawler) ──

export interface DAppConstraint {
  id: string;
  name: string;
  /** Human-readable value, e.g. '100 USDC' / '75-250x' / 'market orders only'. */
  value: string;
  /** Numeric bounds if parseable — used by edge-case derivation. */
  bounds?: { min?: number; max?: number; unit?: string };
  scope: string;               // which module or capability
  source: 'docs' | 'observed' | 'comprehension';
  testImplication: string;
  appliesToControlId?: string;
  appliesToModuleId?: string;
  appliesToCapabilityId?: string;
}

// ── Structured Docs (parsed per section) ──

export interface StructuredDoc {
  id: string;
  title: string;
  content: string;       // full raw content
  topics: string[];      // LLM-extracted main topics
  rules: string[];       // LLM-extracted rule statements
  referencesModuleIds: string[];  // modules this doc is relevant to
}

// ── Plain pipeline state (no LangGraph) ──
// Each pipeline node factory consumes+returns a subset of these fields.

export interface PipelineConfig {
  url: string;
  seedPhrase: string;
  apiKey: string;
  outputDir: string;
  headless: boolean;
  explorerModel: string;
  plannerModel: string;
  generatorModel: string;
  healerModel: string;
}

export interface AgentStateType {
  messages: any[];
  knowledgeGraph: KnowledgeGraph;
  crawlData: any;
  /** Module hierarchy produced by module-discovery. */
  modules?: DAppModule[];
  /** Semantic controls produced by control-clustering. */
  controls?: Control[];
  /** Capabilities derived by graph traversal from controls. */
  capabilities?: Capability[];
  /** First-class constraints (from docs + observed). */
  dappConstraints?: DAppConstraint[];
  /** Structured docs from doc-structurer. */
  structuredDocs?: StructuredDoc[];
  specFiles: string[];
  config: PipelineConfig;
}

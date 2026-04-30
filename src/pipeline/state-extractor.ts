/**
 * State Extractor — replaces kg-migrate's skeleton states with LLM-validated
 * dApp States and the failure-mode taxonomy that turns clickthroughs into
 * tests. ONE LLM call per Flow.
 *
 * Input:  the v2 KG (loaded), the Flow's Actions + bound Components, the
 *         Flow's archetype, the Flow's docSectionIds (if any), and the
 *         dApp's StructuredDocs (for grounding).
 *
 * LLM produces, per flow, a JSON document of the shape:
 *   {
 *     "states": [
 *       { "label": "WalletDisconnected", "isInitial": true, "conditions": {...}, "isError": false },
 *       { "label": "BorrowPanelOpen_AmountValid", "conditions": {...} },
 *       { "label": "BorrowTxPending", "conditions": { "positionStatus": "pending" } },
 *       { "label": "BorrowTxConfirmed_PositionOpen", "conditions": { "positionStatus": "open" } },
 *       { "label": "BorrowRejected_InsufficientCollateral", "isError": true, "conditions": {...} }
 *     ],
 *     "transitions": [
 *       { "actionLabel": "ConnectWallet", "from": "WalletDisconnected", "to": "WalletConnected_NoCollateral", "kind": "success" },
 *       { "actionLabel": "ClickBorrow",  "from": "BorrowPanelOpen_AmountValid", "to": "BorrowRejected_InsufficientCollateral", "kind": "failure", "reason": "amount > available collateral" }
 *     ]
 *   }
 *
 * The extractor then:
 *   - mints fresh State nodes (provenance: 'inferred', source: 'state-extractor:<model>')
 *   - re-points the Flow's startStateId / endStateId to the LLM-named initial/success states
 *   - rewrites REQUIRES_STATE / TRANSITIONS_TO / FAILS_TO edges from each Action
 *     to match the LLM-supplied transitions (matching by actionLabel ↔ Action.label)
 *   - the migrator's skeleton states stay in the graph (provenance-tagged)
 *     so we can diff what the LLM kept vs invented
 *
 * Cost: 1 call per flow × Sonnet 4.5. For Avantis ~50 capabilities → ~50 calls.
 * Use --skip-states or --states-limit N to gate.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createOpenRouterClient } from '../core/llm.js';
import type { AgentStateType, StructuredDoc } from '../agent/state.js';
import {
  KGv2Builder, mintId, stamp, nowIso,
  type StateNode, type FlowNode, type ActionNode, type StateConditions,
} from '../agent/kg-v2.js';
import { loadKGv2, saveKGv2 } from './kg-migrate.js';

const STATE_MODEL = process.env.STATE_MODEL ?? 'anthropic/claude-sonnet-4.5';

interface LLMState {
  label: string;
  isInitial?: boolean;
  isError?: boolean;
  conditions?: StateConditions;
}
interface LLMTransition {
  actionLabel: string;
  from: string;  // state label
  to: string;    // state label
  kind: 'success' | 'failure';
  reason?: string;
}
interface LLMResponse {
  states: LLMState[];
  transitions: LLMTransition[];
}

function extractJson(s: string): LLMResponse | null {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = fenced ? fenced[1] : s;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Retry wrapper: 3 attempts with exponential backoff on connection errors.
 *  Without this, a single OpenRouter blip kills the whole 84-flow run. */
async function withRetries<T>(fn: () => Promise<T>, label: string, maxAttempts = 3): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= maxAttempts; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      const transient = /connection|timeout|rate|429|503|502|ECONN|ETIMEDOUT/i.test(String(e?.message ?? e));
      if (!transient || i === maxAttempts) throw e;
      const backoffMs = 800 * Math.pow(2, i - 1) + Math.floor(Math.random() * 400);
      console.warn(`  ⟳ ${label}: ${e.message?.slice(0, 60)} — retry ${i}/${maxAttempts - 1} in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

export function createStateExtractorNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const { config } = state;
    const outDir = config.outputDir;

    const b = loadKGv2(outDir);
    if (!b) {
      console.log('[state-extractor] no kg-v2.json — run kg-migrate first');
      return {};
    }
    if (!config.apiKey && !process.env.OPENROUTER_API_KEY) {
      console.log('[state-extractor] no OPENROUTER_API_KEY — skipping (would cost credits)');
      return {};
    }

    console.log(`━━━ State Extractor (${STATE_MODEL}) ━━━`);
    const client = createOpenRouterClient(config.apiKey || process.env.OPENROUTER_API_KEY);

    // Load structured docs for grounding.
    const docsPath = join(outDir, 'structured-docs.json');
    const docs: StructuredDoc[] = existsSync(docsPath) ? JSON.parse(readFileSync(docsPath, 'utf-8')) : [];
    const docById = new Map(docs.map(d => [d.id, d]));

    const flows = b.byKind('flow') as FlowNode[];
    const limit = Number(process.env.STATE_EXTRACT_LIMIT ?? flows.length);
    const targets = flows.slice(0, limit);
    console.log(`[state-extractor] ${targets.length} flows (of ${flows.length} total)`);

    const observedAt = nowIso();
    const crawlId = b.crawlId;

    let totalTokens = 0, succeeded = 0, failed = 0;
    // Concurrent processing: 4 LLM calls in flight at once. State mutations
    // happen serially after each batch to keep KGv2Builder consistent. ~4×
    // faster than serial without tripping OpenRouter throttle.
    const CONCURRENCY = Number(process.env.STATE_EXTRACT_CONCURRENCY ?? 4);
    for (let batchStart = 0; batchStart < targets.length; batchStart += CONCURRENCY) {
      const batch = targets.slice(batchStart, batchStart + CONCURRENCY);
      const fetched = await Promise.all(batch.map(async (flow, idx) => {
      const i = batchStart + idx;
      const actions = flow.actionIds.map(aid => b.nodes.get(aid)).filter(n => n?.kind === 'action') as ActionNode[];
      const docCtx = (flow.docSectionIds ?? [])
        .map(d => docById.get(d))
        .filter(Boolean)
        .slice(0, 3)
        .map(d => ({ title: d!.title, rules: d!.rules.slice(0, 8) }));

      // Pull preconditions off the originating capability (via legacyCapabilityId)
      // so the LLM knows the dApp's state BEFORE the flow's first action — fixes
      // the "Wallet_Disconnected as initial" mistake when actions assume connected.
      const startingDappState = (() => {
        const capId = flow.legacyCapabilityId;
        if (!capId) return 'Wallet connected to correct network, on the dApp page where this flow takes place.';
        try {
          const caps = JSON.parse(readFileSync(join(outDir, 'capabilities.json'), 'utf-8')) as Array<{ id: string; preconditions: string[] }>;
          const cap = caps.find(c => c.id === capId);
          if (!cap || !cap.preconditions.length) return 'Wallet connected to correct network, on the dApp page where this flow takes place.';
          return cap.preconditions.join('. ') + '. (These are ALREADY MET when the flow starts — the initial state must reflect this, NOT a fresh disconnected wallet.)';
        } catch { return 'Wallet connected to correct network.'; }
      })();

      const prompt = {
        flow: { name: flow.label, description: flow.description, archetype: flow.archetype },
        startingDappState,
        actions: actions.map(a => ({ label: a.label, type: a.actionType, value: a.inputValue })),
        docs: docCtx,
        instructions: [
          'Enumerate the distinct dApp States this Flow passes through, including ALL failure modes.',
          'CRITICAL: the initial state (isInitial:true) MUST satisfy `startingDappState` above. The action list does NOT include wallet connection — wallet is already connected. Do NOT label the initial state Wallet_Disconnected unless `startingDappState` says wallet is disconnected.',
          'Each Action must transition from a state to a state (success) and SHOULD have at least one failure transition to an error state.',
          'Use action.label EXACTLY to identify which action transitions when.',
          'Prefer state labels like Pascal_Snake (e.g. Wallet_Connected_Idle, BorrowPanelOpen_AmountValid, BorrowTxPending, BorrowRejected_InsufficientCollateral).',
        ].join(' '),
      };

      try {
        const resp = await withRetries(() => client.messages.create({
          model: STATE_MODEL,
          max_tokens: 4000,
          temperature: 0,
          system: [
            'You are extracting a state machine from a Web3 dApp Flow.',
            '',
            'Return STRICT JSON of shape:',
            '{ "states": [{ "label": string, "isInitial"?: boolean, "isError"?: boolean,',
            '   "conditions": { "walletStatus"?: "disconnected"|"connected"|"wrong-network",',
            '                   "network"?: string, "balanceRange"?: { "min"?: number, "max"?: number, "token"?: string },',
            '                   "positionStatus"?: "none"|"pending"|"open"|"closing"|"closed"|"liquidatable",',
            '                   "visibleIndicators"?: string[], "notes"?: string } }],',
            '  "transitions": [{ "actionLabel": string, "from": string, "to": string,',
            '                    "kind": "success"|"failure", "reason"?: string }] }',
            '',
            'Rules:',
            '- Every action.label MUST appear in at least one transition.',
            '- Every action SHOULD have ≥1 failure transition (kind:"failure") if a failure mode is plausible.',
            '- Use the EXACT action.label string supplied (case-sensitive).',
            '- States must be distinct; merge duplicates.',
            '- One state must be isInitial:true. One must be the success terminal.',
            '- The initial state MUST match the user-provided `startingDappState`. If startingDappState says "wallet connected", DO NOT use Wallet_Disconnected as initial.',
            '- The transition chain from initial → ... → success must be CONTIGUOUS (each action\'s `from` must be a `to` of an earlier transition or the initial state). Do not orphan states.',
            '- Be specific about failure causes (insufficient collateral, slippage, wrong network, user rejected, gas estimation failure, etc.).',
            '',
            'Output budget — keep it tight, JSON must NOT be truncated:',
            '- max 14 states total',
            '- max 3 failure transitions per action (only the most impactful)',
            '- conditions.notes max 80 chars',
            '- conditions.visibleIndicators max 3 items, each max 30 chars',
            'No prose. JSON only.',
          ].join('\n'),
          messages: [{ role: 'user', content: JSON.stringify(prompt) }],
        }), `flow ${i + 1}/${targets.length}`);
        totalTokens += (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0);
        const text = resp.content.filter((c: any) => c.type === 'text').map((c: any) => (c as any).text).join('').trim();
        const json = extractJson(text);
        if (!json || !Array.isArray(json.states) || !Array.isArray(json.transitions)) {
          console.warn(`  ✗ flow ${i + 1}/${targets.length} ${flow.label.slice(0, 40)}: bad JSON (stop=${resp.stop_reason}, out=${resp.usage?.output_tokens}t)`);
          return { flow, actions, ok: false as const };
        }
        return { flow, actions, ok: true as const, json };
      } catch (e: any) {
        console.warn(`  ✗ flow ${i + 1}/${targets.length} ${flow.label.slice(0, 40)}: ${e?.message?.slice(0, 80)}`);
        return { flow, actions, ok: false as const };
      }
      }));

      // Apply phase — serial mutation of builder.
      for (const r of fetched) {
        if (!r.ok) { failed++; continue; }
        const { flow, actions, json } = r;
        // Mint fresh State nodes.
        const labelToId = new Map<string, string>();
        let initialId: string | null = null, successId: string | null = null;
        for (const s of json.states) {
          if (!s.label) continue;
          const id = mintId('state', { flowId: flow.id, label: s.label, src: 'state-extractor' });
          labelToId.set(s.label, id);
          const node: StateNode = {
            ...stamp({ id, crawlId, provenance: 'inferred', observedAt, inferenceSource: `state-extractor:${STATE_MODEL}` }),
            layer: 'behavioral', kind: 'state',
            label: s.label,
            conditions: s.conditions ?? { notes: '(LLM did not specify)' },
            ...(s.isError ? { isError: true } : {}),
            ...(s.isInitial ? { isInitial: true } : {}),
          };
          b.addNode(node);
          if (s.isInitial) initialId = id;
          if (!s.isError && !s.isInitial && !successId) successId = id;
        }

        // Re-wire Flow's start/end pointers if LLM provided them.
        const oldStartId = flow.startStateId, oldEndId = flow.endStateId;
        if (initialId) flow.startStateId = initialId;
        // Pick the success terminal: state that has incoming success transitions but no outgoing (terminal in the flow's subgraph).
        const targetTerminals = json.states.filter(s => !s.isError && !s.isInitial);
        if (targetTerminals.length) {
          // Heuristic: last non-error state in the json.states order.
          const term = targetTerminals[targetTerminals.length - 1];
          const tid = labelToId.get(term.label);
          if (tid) flow.endStateId = tid;
        }

        // Update flow node in builder (it's the same reference but mark mutation).
        b.addNode(flow);

        // Re-wire START_STATE / END_STATE edges.
        if (initialId && initialId !== oldStartId) {
          b.addEdge({
            ...stamp({ id: mintId('edge', { from: flow.id, to: initialId, t: 'START_STATE', v: 2 }), crawlId, provenance: 'inferred', observedAt, inferenceSource: `state-extractor:${STATE_MODEL}` }),
            from: flow.id, to: initialId, edgeType: 'START_STATE',
          });
        }
        if (flow.endStateId !== oldEndId) {
          b.addEdge({
            ...stamp({ id: mintId('edge', { from: flow.id, to: flow.endStateId, t: 'END_STATE', v: 2 }), crawlId, provenance: 'inferred', observedAt, inferenceSource: `state-extractor:${STATE_MODEL}` }),
            from: flow.id, to: flow.endStateId, edgeType: 'END_STATE',
          });
        }

        // Match LLM transitions to existing Action nodes by label, emit edges.
        const actionByLabel = new Map<string, ActionNode>();
        for (const a of actions) actionByLabel.set(a.label, a);
        for (const t of json.transitions) {
          const a = actionByLabel.get(t.actionLabel);
          if (!a) continue;
          const fromId = labelToId.get(t.from);
          const toId = labelToId.get(t.to);
          if (!fromId || !toId) continue;
          // REQUIRES_STATE: action requires `from` state.
          b.addEdge({
            ...stamp({ id: mintId('edge', { from: a.id, to: fromId, t: 'REQUIRES_STATE', v: 2 }), crawlId, provenance: 'inferred', observedAt, inferenceSource: `state-extractor:${STATE_MODEL}` }),
            from: a.id, to: fromId, edgeType: 'REQUIRES_STATE',
          });
          // TRANSITIONS_TO or FAILS_TO depending on kind.
          const edgeType = t.kind === 'failure' ? 'FAILS_TO' as const : 'TRANSITIONS_TO' as const;
          b.addEdge({
            ...stamp({ id: mintId('edge', { from: a.id, to: toId, t: edgeType, reason: t.reason ?? '' }), crawlId, provenance: 'inferred', observedAt, inferenceSource: `state-extractor:${STATE_MODEL}` }),
            from: a.id, to: toId, edgeType,
            label: t.reason,
          });
        }

        succeeded++;
      }
      // Periodic save per batch — power-cut resilient.
      saveKGv2(b, outDir);
      console.log(`[state-extractor] batch ${Math.floor(batchStart / CONCURRENCY) + 1}/${Math.ceil(targets.length / CONCURRENCY)} · ${succeeded}✓ ${failed}✗ · ~${Math.round(totalTokens / 1000)}k tok`);
    }

    saveKGv2(b, outDir);
    console.log(`[state-extractor] ${succeeded} flows extracted · ${failed} failed · ~${Math.round(totalTokens / 1000)}k tok`);
    return {};
  };
}

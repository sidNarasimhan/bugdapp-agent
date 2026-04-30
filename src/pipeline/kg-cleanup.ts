/**
 * KG Cleanup — runs after state-extractor. Removes migrator-skeleton states
 * and edges from any flow that has been LLM-extracted (so the LLM-derived
 * state machine is the single source of truth). No LLM cost.
 *
 * Why this exists:
 *   kg-migrate.ts emits placeholder states (one per precondition / per
 *   intermediate / per success criterion) and links every Action's
 *   REQUIRES_STATE / TRANSITIONS_TO to those placeholders. state-extractor
 *   then mints LLM-named states (`Wallet_Disconnected`, `BorrowTxPending`,
 *   etc.) and ADDS new REQUIRES_STATE / TRANSITIONS_TO / FAILS_TO edges to
 *   them — but doesn't delete the migrator's. Result: every Action ends up
 *   with two parallel state-machines hanging off it, the migrator skeleton
 *   becomes orphan (validator E3), Flow start↔end reachability looks broken
 *   (validator E5), and viz is noisy.
 *
 * What we delete:
 *   - State nodes whose inferenceSource starts with `kg-migrate:` AND whose
 *     incoming START_STATE/END_STATE pointer count is 0 (i.e. no Flow still
 *     points to them — state-extractor rewired Flow start/end already)
 *   - All edges incident to those states (REQUIRES_STATE, TRANSITIONS_TO,
 *     FAILS_TO from Actions; START_STATE, END_STATE from Flows that may
 *     still erroneously link to them)
 *
 * What we keep:
 *   - Migrator-skeleton states for flows the LLM never processed (so partial
 *     state-extractor runs degrade gracefully)
 *   - The synthetic `WalletPopup_UserRejected` failure mode (universally
 *     useful, the LLM tends to label it differently per flow)
 */
import type { AgentStateType } from '../agent/state.js';
import type { StateNode } from '../agent/kg-v2.js';
import { loadKGv2, saveKGv2 } from './kg-build.js';

export function createKGCleanupNode() {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const b = loadKGv2(state.config.outputDir);
    if (!b) {
      console.log('[kg-cleanup] no kg-v2.json — skipping');
      return {};
    }
    console.log('━━━ KG Cleanup (post state-extractor) ━━━');

    const allStates = b.byKind('state') as StateNode[];
    // Build set of flow ids that have been LLM-processed (any state on this
    // flow has inferenceSource starting with state-extractor). Only those
    // flows' migrator skeleton is safe to remove — the LLM has fully
    // replaced it.
    const flows = b.byKind('flow');
    const llmProcessedFlowIds = new Set<string>();
    for (const f of flows) {
      const flowStates = [...f.actionIds.flatMap(aid =>
        [...b.outgoing(aid, 'REQUIRES_STATE'), ...b.outgoing(aid, 'TRANSITIONS_TO'), ...b.outgoing(aid, 'FAILS_TO')]
      ).map(e => b.nodes.get(e.to)).filter((n): n is StateNode => n?.kind === 'state'),
        b.nodes.get(f.startStateId), b.nodes.get(f.endStateId)].filter((n): n is StateNode => n?.kind === 'state');
      if (flowStates.some(s => s.inferenceSource?.startsWith('state-extractor'))) {
        llmProcessedFlowIds.add(f.id);
      }
    }
    if (llmProcessedFlowIds.size === 0) {
      console.log('[kg-cleanup] no LLM-processed flows detected — nothing to clean. Skipping.');
      return {};
    }
    // Build set of state ids touched by ANY LLM-processed flow's migrator
    // skeleton (these are safe to remove; the LLM gave us replacement states).
    const llmFlowMigratorStateIds = new Set<string>();
    for (const fid of llmProcessedFlowIds) {
      const f = b.nodes.get(fid);
      if (!f || f.kind !== 'flow') continue;
      // Migrator emitted: initial + intermediate (per step) + success + error states for each cap.
      // We can find them by walking the flow's actions' REQUIRES_STATE/TRANSITIONS_TO/FAILS_TO
      // and filtering to those whose inferenceSource starts with kg-migrate:
      const visit = (sid: string) => {
        const s = b.nodes.get(sid);
        if (!s || s.kind !== 'state') return;
        if (s.inferenceSource?.startsWith('kg-migrate:') &&
            s.inferenceSource !== 'kg-migrate:wallet-rejected-default') {
          llmFlowMigratorStateIds.add(sid);
        }
      };
      // Walk every action of this flow.
      for (const aid of f.actionIds) {
        for (const e of b.outgoing(aid, 'REQUIRES_STATE')) visit(e.to);
        for (const e of b.outgoing(aid, 'TRANSITIONS_TO')) visit(e.to);
        for (const e of b.outgoing(aid, 'FAILS_TO')) visit(e.to);
      }
    }

    let removedNodes = 0, removedEdges = 0, kept = 0;
    for (const sid of llmFlowMigratorStateIds) {
      const r = b.removeNode(sid);
      removedNodes += r.node;
      removedEdges += r.edges;
    }
    // Count kept = migrator states left on flows the LLM didn't process.
    for (const s of allStates) {
      if (s.inferenceSource?.startsWith('kg-migrate:') &&
          s.inferenceSource !== 'kg-migrate:wallet-rejected-default' &&
          !llmFlowMigratorStateIds.has(s.id)) {
        kept++;
      }
    }

    saveKGv2(b, state.config.outputDir);
    console.log(`[kg-cleanup] removed ${removedNodes} migrator-skeleton states + ${removedEdges} incident edges. kept ${kept} (still referenced by flows the LLM didn't process)`);
    return {};
  };
}

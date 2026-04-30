/**
 * KG Assemble — single orchestrator that owns building kg-v2.json.
 *
 * Sequence:
 *   1. kg-migrate            (no LLM)  build skeleton from v1 sidecars
 *   2. tech-binder           (no LLM)  bind ApiCall/ContractCall/Event
 *   3. explorer-ingest       (no LLM)  fold runtime-observed deltas in
 *                                      (additional constraints + observed
 *                                      states/transitions written to
 *                                      exploration-deltas.json for state-
 *                                      extractor + spec-gen to consume)
 *   4. state-extractor       (LLM)     replace skeleton states with real
 *                                      named state machines per flow.
 *                                      Skipped automatically if --skip-states.
 *   5. kg-cleanup            (no LLM)  drop migrator skeletons that
 *                                      state-extractor superseded
 *   6. kg-validator          (no LLM)  schema + assertion completeness
 *
 * Why one orchestrator: phases 1-2-3-5-6 are all deterministic post-derive
 * work that only existed as separate phases for development ergonomics.
 * Collapsing the public surface to one Phase reduces pipeline.ts noise and
 * gives explorer-ingest a clean injection point right before the LLM step.
 *
 * The underlying node functions are still exported by their files —
 * everything stays unit-testable. This file just composes them.
 */
import { createKGMigrateNode } from './kg-migrate.js';
import { createTechBinderNode } from './tech-binder.js';
import { createExplorerIngestNode } from './explorer-ingest.js';
import { createStateExtractorNode } from './state-extractor.js';
import { createKGCleanupNode } from './kg-cleanup.js';
import { createKGValidatorNode } from './kg-validator.js';
import type { AgentStateType } from '../agent/state.js';

export interface AssembleOpts {
  skipStateExtractor?: boolean;   // when no LLM credits available
  skipExplorerIngest?: boolean;
  skipValidator?: boolean;
}

export function createKGAssembleNode(opts: AssembleOpts = {}) {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    let merged: Partial<AgentStateType> = {};

    console.log('\n  ─ assemble step 1/6: KG Migrate (skeleton from v1 sidecars)');
    Object.assign(state, merged = await createKGMigrateNode()(state));

    console.log('\n  ─ assemble step 2/6: Tech Binder (api/contract/event)');
    Object.assign(state, merged = await createTechBinderNode()(state));

    if (!opts.skipExplorerIngest) {
      console.log('\n  ─ assemble step 3/6: Explorer Ingest (runtime deltas)');
      Object.assign(state, merged = await createExplorerIngestNode()(state));
    } else {
      console.log('\n  ─ assemble step 3/6: --skip-explorer-ingest');
    }

    if (!opts.skipStateExtractor) {
      console.log('\n  ─ assemble step 4/6: State Extractor (LLM, per-flow)');
      Object.assign(state, merged = await createStateExtractorNode()(state));
    } else {
      console.log('\n  ─ assemble step 4/6: --skip-states (KG keeps migrator skeleton states)');
    }

    console.log('\n  ─ assemble step 5/6: KG Cleanup');
    Object.assign(state, merged = await createKGCleanupNode()(state));

    if (!opts.skipValidator) {
      console.log('\n  ─ assemble step 6/6: KG Validator');
      Object.assign(state, merged = await createKGValidatorNode()(state));
    } else {
      console.log('\n  ─ assemble step 6/6: --skip-validate');
    }

    return merged;
  };
}

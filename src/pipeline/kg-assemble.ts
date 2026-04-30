/**
 * KG Assemble — TWO orchestrators that bracket the live Explorer phase so
 * the explorer's findings inform state-extractor's naming WITHIN the same
 * pipeline run (closes the loop that was previously one-run-behind).
 *
 *   pipeline.ts ordering:
 *     ── PHASE 10a  assembleSkeleton()      build kg-v2 skeleton
 *     ── PHASE 11   markdown                give explorer agent module docs
 *     ── PHASE 12   explorer (live agent)   walks the skeleton brain
 *     ── PHASE 10b  assembleFinalize()      ingest deltas + name states + validate
 *     ── PHASE 13   spec-gen                consumes finalized kg-v2
 *
 *   assembleSkeleton sub-steps (no LLM):
 *     1. kg-migrate            v1 sidecars → 4-layer skeleton kg-v2
 *     2. tech-binder           bind ApiCall / ContractCall / Event onto actions
 *
 *   assembleFinalize sub-steps:
 *     3. explorer-ingest       (no LLM)  fold runtime deltas (this run's
 *                                        exploration.json) into kg-v2 +
 *                                        write exploration-deltas.json
 *     4. state-extractor       (LLM)     replace skeleton states with named
 *                                        machines; sees exploration deltas
 *                                        in its prompt context. Skipped if
 *                                        --skip-states.
 *     5. kg-cleanup            (no LLM)  drop migrator skeletons that the
 *                                        LLM superseded
 *     6. kg-validator          (no LLM)  schema + assertion completeness
 *
 * Underlying node functions stay in their own files — testable individually.
 * This module just composes them so the pipeline reads as two phase blocks
 * with the live agent sandwiched between.
 */
import { createKGMigrateNode } from './kg-migrate.js';
import { createTechBinderNode } from './tech-binder.js';
import { createExplorerIngestNode } from './explorer-ingest.js';
import { createStateExtractorNode } from './state-extractor.js';
import { createKGCleanupNode } from './kg-cleanup.js';
import { createKGValidatorNode } from './kg-validator.js';
import type { AgentStateType } from '../agent/state.js';

export interface SkeletonOpts {}

export interface FinalizeOpts {
  skipStateExtractor?: boolean;     // when no LLM credits available
  skipExplorerIngest?: boolean;     // bypass exploration.json mining
  skipValidator?: boolean;
}

/** Phase 10a — skeleton brain. Runs BEFORE the live explorer agent so the
 *  agent has a queryable graph to walk. No LLM calls. */
export function createKGAssembleSkeletonNode(_opts: SkeletonOpts = {}) {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    let merged: Partial<AgentStateType> = {};

    console.log('\n  ─ skeleton 1/2: KG Migrate (v1 sidecars → 4-layer skeleton)');
    Object.assign(state, merged = await createKGMigrateNode()(state));

    console.log('\n  ─ skeleton 2/2: Tech Binder (api / contract / event bindings)');
    Object.assign(state, merged = await createTechBinderNode()(state));

    return merged;
  };
}

/** Phase 10b — finalize brain. Runs AFTER the live explorer agent so its
 *  observations can inform state-extractor's per-flow naming. */
export function createKGAssembleFinalizeNode(opts: FinalizeOpts = {}) {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    let merged: Partial<AgentStateType> = {};

    if (!opts.skipExplorerIngest) {
      console.log('\n  ─ finalize 1/4: Explorer Ingest (this-run deltas → kg-v2 + dappConstraints)');
      Object.assign(state, merged = await createExplorerIngestNode()(state));
    } else {
      console.log('\n  ─ finalize 1/4: --skip-explorer-ingest');
    }

    if (!opts.skipStateExtractor) {
      console.log('\n  ─ finalize 2/4: State Extractor (LLM, per-flow — sees exploration deltas)');
      Object.assign(state, merged = await createStateExtractorNode()(state));
    } else {
      console.log('\n  ─ finalize 2/4: --skip-states (KG keeps migrator skeleton states)');
    }

    console.log('\n  ─ finalize 3/4: KG Cleanup (drop superseded skeletons)');
    Object.assign(state, merged = await createKGCleanupNode()(state));

    if (!opts.skipValidator) {
      console.log('\n  ─ finalize 4/4: KG Validator');
      Object.assign(state, merged = await createKGValidatorNode()(state));
    } else {
      console.log('\n  ─ finalize 4/4: --skip-validate');
    }

    return merged;
  };
}

/** Convenience: skeleton + finalize back-to-back, with no live explorer in
 *  between. Used when re-running the deterministic path or when explorer is
 *  skipped entirely. Equivalent to the old single-orchestrator behavior. */
export function createKGAssembleNode(opts: FinalizeOpts = {}) {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    Object.assign(state, await createKGAssembleSkeletonNode()(state));
    return createKGAssembleFinalizeNode(opts)(state);
  };
}

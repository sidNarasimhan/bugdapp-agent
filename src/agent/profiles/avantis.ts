/**
 * Avantis — identity + URL/chain match only. All substantive knowledge
 * (min position, leverage bounds, ZFP rules, connect flow, flows) lives in
 * the KG + comprehension artifacts at output/developer-avantisfi-com/.
 *
 * This file intentionally holds only what is NOT derivable from the crawler.
 */
import type { DAppProfile } from './types.js';
import { NETWORKS } from './networks.js';

export const avantisProfile: DAppProfile = {
  name: 'Avantis',
  urlMatches: ['developer.avantisfi.com', 'avantisfi.com', /(?:^|\.)avantisfi\.com/],
  url: 'https://developer.avantisfi.com/trade',
  archetype: 'perps',
  network: NETWORKS.base,

  // values/selectors/inverseFlows/notes intentionally empty — the agent pulls
  // that knowledge from comprehension.json + knowledge-graph.json via
  // src/chat/agent/knowledge-loader.ts.
  values: {},
};

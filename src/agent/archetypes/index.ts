import type { ArchetypeName } from '../../types.js';
import type { Archetype } from './types.js';
import { perpsArchetype } from './perps.js';
import { swapArchetype } from './swap.js';
import { lendingArchetype } from './lending.js';
import { stakingArchetype } from './staking.js';
import { cdpArchetype } from './cdp.js';
import { yieldArchetype } from './yield.js';

const ARCHETYPES: Record<ArchetypeName, Archetype | undefined> = {
  perps: perpsArchetype,
  swap: swapArchetype,
  lending: lendingArchetype,
  staking: stakingArchetype,
  cdp: cdpArchetype,
  yield: yieldArchetype,
  // Built later — each added when its first profile needs it
  lp: undefined,
  bridge: undefined,
};

export function getArchetype(name: ArchetypeName): Archetype {
  const arch = ARCHETYPES[name];
  if (!arch) {
    throw new Error(`Archetype '${name}' is not implemented yet. Build src/agent/archetypes/${name}.ts`);
  }
  return arch;
}

export { perpsArchetype, swapArchetype, lendingArchetype };
export type { Archetype, ClassifyContext } from './types.js';

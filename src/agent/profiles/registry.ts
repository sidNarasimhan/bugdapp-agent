/**
 * Profile registry — URL → DAppProfile lookup.
 *
 * New profiles: add them here. The registry matches on hostname substring or regex.
 */
import type { DAppProfile } from './types.js';
import { avantisProfile } from './avantis.js';
import { uniswapProfile } from './uniswap.js';
import { aaveProfile } from './aave.js';
import { gmxProfile } from './gmx.js';
import { vertexProfile } from './vertex.js';
import { curveProfile } from './curve.js';
import { pancakeswapProfile } from './pancakeswap.js';
import { aerodromeProfile } from './aerodrome.js';
import { velodromeProfile } from './velodrome.js';
import { traderJoeProfile } from './traderjoe.js';
import { quickswapProfile } from './quickswap.js';
import { balancerProfile } from './balancer.js';
import { compoundProfile } from './compound.js';
import { morphoProfile } from './morpho.js';
import { benqiProfile } from './benqi.js';
import { venusProfile } from './venus.js';
import { lidoProfile } from './lido.js';
import { skyProfile } from './sky.js';
import { pendleProfile } from './pendle.js';
import { yearnProfile } from './yearn.js';

export const PROFILES: DAppProfile[] = [
  avantisProfile,
  uniswapProfile,
  aaveProfile,
  gmxProfile,
  vertexProfile,
  curveProfile,
  pancakeswapProfile,
  aerodromeProfile,
  velodromeProfile,
  traderJoeProfile,
  quickswapProfile,
  balancerProfile,
  compoundProfile,
  morphoProfile,
  benqiProfile,
  venusProfile,
  lidoProfile,
  skyProfile,
  pendleProfile,
  yearnProfile,
];

export function findProfile(url: string): DAppProfile | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    hostname = url.toLowerCase();
  }

  for (const profile of PROFILES) {
    for (const matcher of profile.urlMatches) {
      if (typeof matcher === 'string') {
        if (hostname === matcher.toLowerCase() || hostname.includes(matcher.toLowerCase())) {
          return profile;
        }
      } else if (matcher instanceof RegExp) {
        if (matcher.test(hostname) || matcher.test(url)) {
          return profile;
        }
      }
    }
  }
  return null;
}

export function getProfileOrThrow(url: string): DAppProfile {
  const profile = findProfile(url);
  if (!profile) {
    const known = PROFILES.map(p => p.name).join(', ');
    throw new Error(
      `No dApp profile found for '${url}'. Known profiles: ${known}. ` +
      `Add one in src/agent/profiles/ and register it in src/agent/profiles/registry.ts`,
    );
  }
  return profile;
}

export type { DAppProfile } from './types.js';

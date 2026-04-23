/**
 * Chat command parser. Maps free-text user requests to executable actions.
 *
 * Examples:
 *   "test trade flow on avantis"         -> { kind: 'run', dApp: 'avantis', filter: 'perps' }
 *   "run swap on aerodrome"              -> { kind: 'run', dApp: 'aerodrome', filter: 'swap' }
 *   "audit aave"                         -> { kind: 'run', dApp: 'aave', filter: 'all' }
 *   "list dapps"                         -> { kind: 'list' }
 *   "help"                               -> { kind: 'help' }
 *
 * Regex-based. No LLM. The grammar is tiny on purpose — scope creep
 * belongs on a backlog, not in a parser.
 */
import { PROFILES } from '../agent/profiles/registry.js';
import type { DAppProfile } from '../agent/profiles/types.js';

export type Command =
  | { kind: 'run'; dApp: DAppProfile; filter: SpecFilter }
  | { kind: 'list' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'unknown'; input: string; hint?: string };

export type SpecFilter = 'all' | 'perps' | 'swap' | 'lending' | 'staking' | 'cdp' | 'yield' | 'navigation' | 'adversarial';

const FILTER_ALIASES: Record<string, SpecFilter> = {
  'trade': 'perps', 'trade flow': 'perps', 'perp': 'perps', 'perps': 'perps',
  'swap': 'swap', 'swap flow': 'swap',
  'lending': 'lending', 'lend': 'lending', 'supply': 'lending', 'borrow': 'lending',
  'stake': 'staking', 'staking': 'staking',
  'cdp': 'cdp', 'vault': 'cdp',
  'yield': 'yield', 'farm': 'yield',
  'nav': 'navigation', 'navigation': 'navigation',
  'adversarial': 'adversarial', 'fuzz': 'adversarial', 'edge': 'adversarial',
  'all': 'all', 'full': 'all', 'audit': 'all', 'everything': 'all',
};

function resolveDApp(token: string): DAppProfile | null {
  const t = token.toLowerCase().trim();
  // direct name match (case-insensitive)
  for (const p of PROFILES) {
    if (p.name.toLowerCase() === t) return p;
    if (p.name.toLowerCase().replace(/\s+/g, '') === t.replace(/\s+/g, '')) return p;
  }
  // URL match
  try {
    const host = new URL(t.startsWith('http') ? t : `https://${t}`).hostname.toLowerCase();
    for (const p of PROFILES) {
      for (const m of p.urlMatches) {
        if (typeof m === 'string' && (host === m.toLowerCase() || host.includes(m.toLowerCase()))) return p;
        if (m instanceof RegExp && m.test(host)) return p;
      }
    }
  } catch {}
  // substring on profile name / url
  for (const p of PROFILES) {
    if (p.name.toLowerCase().includes(t) || p.url.toLowerCase().includes(t)) return p;
  }
  return null;
}

function resolveFilter(token: string): SpecFilter | null {
  const t = token.toLowerCase().trim();
  if (t in FILTER_ALIASES) return FILTER_ALIASES[t];
  for (const [k, v] of Object.entries(FILTER_ALIASES)) {
    if (t.includes(k)) return v;
  }
  return null;
}

export function parseCommand(input: string): Command {
  const raw = input.trim();
  const lower = raw.toLowerCase();

  if (!raw) return { kind: 'unknown', input: raw, hint: 'empty input' };
  if (/^(help|\?|commands)$/.test(lower)) return { kind: 'help' };
  if (/^(list|dapps|which dapps|what dapps)/.test(lower)) return { kind: 'list' };
  if (/^status$/.test(lower)) return { kind: 'status' };

  // "audit X" / "test X" / "full audit X"
  const audit = lower.match(/^(?:run\s+)?(?:full\s+)?audit\s+(.+)$/);
  if (audit) {
    const d = resolveDApp(audit[1]);
    if (d) return { kind: 'run', dApp: d, filter: 'all' };
    return { kind: 'unknown', input: raw, hint: `unknown dApp: ${audit[1]}` };
  }

  // "test|run <filter> (flow|test|tests)? on <dApp>"
  const onMatch = lower.match(/^(?:test|run|check|verify)\s+(.+?)\s+on\s+(.+)$/);
  if (onMatch) {
    const filter = resolveFilter(onMatch[1]);
    const d = resolveDApp(onMatch[2]);
    if (filter && d) return { kind: 'run', dApp: d, filter };
    if (!d) return { kind: 'unknown', input: raw, hint: `unknown dApp: ${onMatch[2]}` };
    return { kind: 'unknown', input: raw, hint: `unknown filter: ${onMatch[1]}` };
  }

  // "test|run <dApp>"  (filter defaults to all)
  const simple = lower.match(/^(?:test|run|check|verify)\s+(.+)$/);
  if (simple) {
    const d = resolveDApp(simple[1]);
    if (d) return { kind: 'run', dApp: d, filter: 'all' };
    return { kind: 'unknown', input: raw, hint: `unknown dApp: ${simple[1]}` };
  }

  // bare dApp name -> run all
  const bare = resolveDApp(raw);
  if (bare) return { kind: 'run', dApp: bare, filter: 'all' };

  return { kind: 'unknown', input: raw };
}

export function helpText(): string {
  const names = PROFILES.map(p => p.name).sort().join(', ');
  return [
    '**bugdapp-agent commands**',
    '`test <flow> on <dapp>`    — run specific spec (e.g. `test trade flow on avantis`)',
    '`audit <dapp>`             — run full suite',
    '`list`                     — show available dApps',
    '`status`                   — show active runs',
    '`help`                     — this message',
    '',
    `**Flows:** trade / swap / lending / staking / cdp / yield / nav / adversarial / all`,
    `**dApps:** ${names}`,
  ].join('\n');
}

/**
 * In-memory pending-approval store. Keyed by (platform, userId, channelId).
 * Approvals expire after 10 min.
 */

export type Pending =
  | { kind: 'spec'; dAppName: string; specFile: string; task: string; createdAt: number }
  | { kind: 'act'; dAppName: string; task: string; createdAt: number };

const PENDING_TTL_MS = 10 * 60 * 1000;
const store = new Map<string, Pending>();

export function key(platform: string, userId: string, channelId: string): string {
  return `${platform}:${userId}:${channelId}`;
}

export type PendingInput =
  | { kind: 'spec'; dAppName: string; specFile: string; task: string }
  | { kind: 'act'; dAppName: string; task: string };

export function setPending(k: string, p: PendingInput): void {
  store.set(k, { ...p, createdAt: Date.now() } as Pending);
  const t = setTimeout(() => {
    const cur = store.get(k);
    if (cur && Date.now() - cur.createdAt >= PENDING_TTL_MS) store.delete(k);
  }, PENDING_TTL_MS + 1000);
  if (typeof (t as any).unref === 'function') (t as any).unref();
}

export function getPending(k: string): Pending | null {
  const p = store.get(k);
  if (!p) return null;
  if (Date.now() - p.createdAt > PENDING_TTL_MS) {
    store.delete(k);
    return null;
  }
  return p;
}

export function clearPending(k: string): void { store.delete(k); }

const APPROVE_RE = /^\s*(go|yes|y|approved?|ship|run it?|do it|proceed|lgtm|ok|okay)\b|^\s*(👍|✅)/i;
const REJECT_RE = /^\s*(no|n|cancel|stop|abort|nope|nah|kill)\b|^\s*(👎|❌)/i;

export function classifyReply(text: string): 'approve' | 'reject' | null {
  if (APPROVE_RE.test(text)) return 'approve';
  if (REJECT_RE.test(text)) return 'reject';
  return null;
}

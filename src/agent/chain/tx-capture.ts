/**
 * Tx capture — intercepts transaction hashes submitted through MetaMask during
 * a Playwright test run, with no modification to the dApp under test.
 *
 * Implementation strategy:
 *
 *   1. On the Playwright page, an addInitScript runs BEFORE any dApp code. It installs
 *      a tiny shim that:
 *        - Defines a getter/setter on `window.ethereum` so that when MetaMask's
 *          content script later assigns the provider, we intercept the set, wrap it
 *          in a Proxy, and return the Proxy for all subsequent reads.
 *        - The Proxy's `request` method proxies to the real provider, but whenever
 *          the RPC method is `eth_sendTransaction` or `eth_sendRawTransaction`, it
 *          awaits the response (the tx hash), pushes it onto `window.__bugdappCapturedTxs`,
 *          and also emits a console.log with a well-known marker so the Playwright
 *          test runner can pick it up without polling.
 *        - If `window.ethereum` is already installed by the time our shim runs
 *          (edge case: extension injected very early), the shim patches the existing
 *          provider in place instead.
 *
 *   2. On the Node side, `installTxCapture(page)` attaches two things:
 *        - page.addInitScript with the shim source,
 *        - page.on('console', ...) listener that parses the marker lines and
 *          stores captured txs on the page object under a Symbol key.
 *
 *   3. After the test runs, `getCapturedTxs(page)` returns the list of captured txs.
 *      We merge the page's in-memory array with the in-world window array — whichever
 *      side misses, the other catches.
 *
 * This runs without source-patching MetaMask, and works identically for a live RPC
 * connection and for an Anvil fork, because MetaMask's provider API is the same.
 */
import type { Page } from '@playwright/test';
import type { CapturedTx } from './types.js';

/** Sentinel key used to stash the Node-side accumulator on the Playwright Page. */
const TX_ACCUMULATOR_KEY = Symbol.for('bugdapp.txAccumulator');

/** The well-known console marker we parse on the Node side. */
const CONSOLE_MARKER = '[BUGDAPP_TX_CAPTURE]';

/**
 * Shim source — this is what runs in the browser page's world BEFORE any dApp code.
 * Kept as a function so we can stringify it for addInitScript. Do not import from
 * outside this function inside the shim body — it executes in an isolated world.
 */
function shimSource() {
  // In browser context. Types here are loose on purpose — no TS-visible DOM imports.
  const w = window as any;
  if (w.__bugdappCaptureInstalled) return;
  w.__bugdappCaptureInstalled = true;
  w.__bugdappCapturedTxs = [] as Array<{ hash: string; method: string; chainId?: string; observedAt: number; fromHint?: string }>;

  const WATCHED_METHODS = new Set(['eth_sendTransaction', 'eth_sendRawTransaction']);
  const CONSOLE_MARKER_LOCAL = '[BUGDAPP_TX_CAPTURE]';

  function wrap(provider: any): any {
    if (!provider || provider.__bugdappWrapped) return provider;
    const originalRequest = provider.request ? provider.request.bind(provider) : null;
    if (!originalRequest) return provider;

    const wrapped = new Proxy(provider, {
      get(target, prop, receiver) {
        if (prop === 'request') {
          return async function (args: any) {
            const method = args && args.method;
            const fromHint = args?.params?.[0]?.from;
            const result = await originalRequest(args);
            if (WATCHED_METHODS.has(method) && typeof result === 'string' && result.startsWith('0x')) {
              let chainId: string | undefined;
              try {
                chainId = await originalRequest({ method: 'eth_chainId' });
              } catch {
                chainId = undefined;
              }
              const entry = { hash: result, method, chainId, observedAt: Date.now(), fromHint };
              w.__bugdappCapturedTxs.push(entry);
              try {
                // Stringify with the well-known marker so the Node-side console listener picks it up.
                // eslint-disable-next-line no-console
                console.log(`${CONSOLE_MARKER_LOCAL}${JSON.stringify(entry)}`);
              } catch {
                // console access revoked — in-world array still captures it
              }
            }
            return result;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      Object.defineProperty(wrapped, '__bugdappWrapped', { value: true, enumerable: false });
    } catch {
      // prop may be non-configurable on frozen providers; array capture still works
    }
    return wrapped;
  }

  // If the provider is already installed (extension injected before our shim), patch it in place.
  let current: any = undefined;
  try {
    current = Object.getOwnPropertyDescriptor(w, 'ethereum')?.value;
  } catch {
    current = undefined;
  }
  if (current) {
    try {
      const wrapped = wrap(current);
      Object.defineProperty(w, 'ethereum', { value: wrapped, configurable: true, writable: true });
    } catch {
      // fallthrough: dApp will read the unwrapped provider, in-world array won't populate
    }
    return;
  }

  // Otherwise, intercept the eventual assignment. Holds a private slot for whatever
  // the extension sets, and returns the wrapped proxy on read.
  let stored: any = undefined;
  try {
    Object.defineProperty(w, 'ethereum', {
      configurable: true,
      get() {
        return stored;
      },
      set(value) {
        stored = wrap(value);
      },
    });
  } catch {
    // property couldn't be redefined — in-world capture unavailable for this page
  }
}

/**
 * Attach the capture shim to a Playwright Page. Must be called BEFORE the test
 * navigates to the dApp URL. Safe to call multiple times — idempotent.
 */
export async function installTxCapture(page: Page): Promise<void> {
  // addInitScript runs before any dApp script on every navigation.
  await page.addInitScript({ content: `(${shimSource.toString()})();` });

  // Node-side accumulator for this page. Lives on the Page object so the fixture can
  // find it later without a global singleton (multi-page/tab safe).
  const accumulator: CapturedTx[] = [];
  (page as any)[TX_ACCUMULATOR_KEY] = accumulator;

  page.on('console', msg => {
    const text = msg.text();
    const idx = text.indexOf(CONSOLE_MARKER);
    if (idx < 0) return;
    try {
      const payload = JSON.parse(text.slice(idx + CONSOLE_MARKER.length));
      const chainId = payload.chainId ? Number.parseInt(payload.chainId, 16) : 0;
      accumulator.push({
        hash: payload.hash,
        chainId,
        observedAt: payload.observedAt ?? Date.now(),
        fromHint: payload.fromHint,
        method: payload.method,
      });
    } catch {
      // malformed marker line — ignore
    }
  });
}

/**
 * Fetch the list of captured txs from a page. Merges the Node-side console accumulator
 * with the in-world window array (deduped by hash). Returns a defensively-copied list.
 */
export async function getCapturedTxs(page: Page): Promise<CapturedTx[]> {
  const consoleTxs: CapturedTx[] = (page as any)[TX_ACCUMULATOR_KEY] ?? [];
  let worldTxs: CapturedTx[] = [];
  try {
    worldTxs = await page.evaluate(() => {
      const arr = (window as any).__bugdappCapturedTxs || [];
      return arr.map((e: any) => ({
        hash: e.hash,
        chainId: e.chainId ? parseInt(e.chainId, 16) : 0,
        observedAt: e.observedAt ?? Date.now(),
        fromHint: e.fromHint,
        method: e.method,
      }));
    });
  } catch {
    worldTxs = [];
  }

  // Dedupe by hash, preferring the console-side record (richer chain id parsing).
  const byHash = new Map<string, CapturedTx>();
  for (const tx of [...worldTxs, ...consoleTxs]) {
    byHash.set(tx.hash.toLowerCase(), tx);
  }
  return [...byHash.values()].sort((a, b) => a.observedAt - b.observedAt);
}

/** Reset the accumulator on a page — useful between test phases. */
export function clearCapturedTxs(page: Page): void {
  const acc: CapturedTx[] = (page as any)[TX_ACCUMULATOR_KEY];
  if (acc) acc.length = 0;
  page.evaluate(() => { (window as any).__bugdappCapturedTxs = []; }).catch(() => { /* noop */ });
}

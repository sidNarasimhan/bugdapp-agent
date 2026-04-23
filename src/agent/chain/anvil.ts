/**
 * Anvil fork runner — spawns a local Anvil instance forking a live chain at a
 * pinned (or latest) block, waits for readiness, and returns a handle with the
 * RPC URL + kill function. Used by scripts/anvil-run.ts and any future in-
 * process flow that wants a throwaway chain state for deterministic tests.
 *
 * Requires `anvil` (from Foundry) to be installed and on PATH. This file never
 * downloads or installs foundry — if it's missing, startAnvilFork throws with
 * a clear error pointing at https://getfoundry.sh.
 *
 * Design choices:
 *   - Port is picked from a user-supplied value (default 8545) and the handle
 *     returns the actual URL so callers can route viem + MetaMask at it.
 *   - Fork URL is taken from $CHAIN_RPC_<chainId> so users who already set
 *     public-RPC overrides get the same endpoint for forking.
 *   - --chain-id is preserved by default (Anvil inherits from the fork),
 *     which means the dApp under test sees its expected chain ID.
 *   - readiness is detected via JSON-RPC eth_blockNumber polling, not by
 *     stdout scraping — that way we don't depend on anvil's log format.
 *   - kill() is idempotent and waits briefly for the process to exit.
 */
import { execa } from 'execa';
import { existsSync } from 'fs';
import { join } from 'path';
// execa 9+ dropped the `ExecaChildProcess` named export. Derive the child type from
// the function return so we don't pin ourselves to a specific execa major.
type ExecaChildProcess = ReturnType<typeof execa>;

/**
 * Resolve the anvil binary path. Honours $FOUNDRY_BIN (custom install location),
 * falls back to `$HOME/.foundry/bin/anvil` (the default foundryup target), and
 * finally falls back to 'anvil' (PATH lookup). This lets us run on Windows where
 * the foundryup install directory isn't typically on PATH.
 */
function resolveAnvilBin(): string {
  const custom = process.env.FOUNDRY_BIN;
  if (custom) {
    const candidates = [join(custom, 'anvil'), join(custom, 'anvil.exe')];
    for (const c of candidates) if (existsSync(c)) return c;
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const candidates = [join(home, '.foundry', 'bin', 'anvil.exe'), join(home, '.foundry', 'bin', 'anvil')];
    for (const c of candidates) if (existsSync(c)) return c;
  }
  return 'anvil';
}
import { createPublicClient, http } from 'viem';
import { resolveRpcUrl, getChainEntry } from './chains.js';

export interface AnvilOptions {
  /** Chain id to fork. */
  chainId: number;
  /** Optional fork URL override. Defaults to resolveRpcUrl(chainId). */
  forkUrl?: string;
  /** Optional pinned block number. Defaults to 'latest'. */
  forkBlockNumber?: bigint | number;
  /** Local port Anvil binds to. Default 8545. */
  port?: number;
  /** Optional block gas limit override — useful for adversarial tests. */
  blockGasLimit?: number;
  /** Silence Anvil's stdout. Default true — most callers don't want the spam. */
  silent?: boolean;
  /** Extra args passed through to anvil (power users). */
  extraArgs?: string[];
  /** How long to wait for readiness before giving up. Default 15s. */
  readyTimeoutMs?: number;
}

export interface AnvilHandle {
  /** The RPC URL exposed by the running anvil process, e.g. http://127.0.0.1:8545 */
  rpcUrl: string;
  /** Chain id preserved from the fork. */
  chainId: number;
  /** The block number Anvil resolved the fork to. */
  forkedAt: bigint;
  /** Terminate the Anvil process. Idempotent. Resolves after the process exits. */
  kill: () => Promise<void>;
}

/**
 * Start an Anvil fork and wait until it responds to eth_blockNumber. Throws
 * if Anvil is not installed, fails to bind the port, or doesn't become ready
 * within readyTimeoutMs.
 */
export async function startAnvilFork(opts: AnvilOptions): Promise<AnvilHandle> {
  const chainEntry = getChainEntry(opts.chainId);
  const forkUrl = opts.forkUrl ?? resolveRpcUrl(opts.chainId);
  const port = opts.port ?? 8545;
  const rpcUrl = `http://127.0.0.1:${port}`;

  const args: string[] = [
    '--fork-url', forkUrl,
    '--port', String(port),
    '--chain-id', String(opts.chainId),
    '--host', '127.0.0.1',
    '--accounts', '1',
    '--balance', '1000',
    '--mnemonic', 'test test test test test test test test test test test junk',
  ];
  if (opts.forkBlockNumber !== undefined) {
    args.push('--fork-block-number', String(opts.forkBlockNumber));
  }
  if (opts.blockGasLimit) {
    args.push('--block-gas-limit', String(opts.blockGasLimit));
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  const anvilBin = resolveAnvilBin();
  let child: ExecaChildProcess;
  try {
    child = execa(anvilBin, args, {
      stdio: opts.silent === false ? 'inherit' : 'ignore',
      reject: false,
    });
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new Error(`anvil binary not found at "${anvilBin}" — install foundry (https://getfoundry.sh) or set FOUNDRY_BIN in .env`);
    }
    throw err;
  }

  // Wait for readiness via eth_blockNumber polling. Anvil usually responds within
  // 500–1500ms; public RPCs with slow fork points can take 5s+. We also watch the
  // child process — if it exits early, fail fast with the exit code.
  const started = Date.now();
  const timeoutMs = opts.readyTimeoutMs ?? 15_000;
  let forkedAt: bigint | null = null;
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 2000 }) });
  let lastErr: unknown = null;
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`anvil exited early with code ${child.exitCode} — check --fork-url (${forkUrl}) and that port ${port} is free`);
    }
    try {
      forkedAt = await client.getBlockNumber();
      break;
    } catch (e) {
      lastErr = e;
      await sleep(250);
    }
  }
  if (forkedAt === null) {
    try { child.kill('SIGINT'); } catch {}
    throw new Error(`anvil on ${rpcUrl} did not become ready within ${timeoutMs}ms — last error: ${String((lastErr as any)?.message ?? lastErr)}`);
  }

  const handle: AnvilHandle = {
    rpcUrl,
    chainId: opts.chainId,
    forkedAt,
    kill: async () => {
      if (child.exitCode !== null && child.exitCode !== undefined) return;
      try {
        child.kill('SIGINT');
      } catch { /* already dead */ }
      // Give it a brief window to shut down cleanly before forcing.
      const killBy = Date.now() + 3000;
      while (Date.now() < killBy) {
        if (child.exitCode !== null && child.exitCode !== undefined) return;
        await sleep(100);
      }
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    },
  };

  // Best-effort: log a short banner so operators know the fork is up.
  // eslint-disable-next-line no-console
  console.log(`[anvil] forked ${chainEntry.slug} (chainId ${opts.chainId}) at block ${forkedAt} — ${rpcUrl}`);
  return handle;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

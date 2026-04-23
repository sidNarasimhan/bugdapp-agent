#!/usr/bin/env npx tsx
/**
 * Anvil-backed test runner — spins up a local Anvil fork of the target dApp's
 * chain, pre-funds the test wallet, routes the chain verification layer at the
 * fork via CHAIN_RPC_<id>, and spawns Playwright against the dApp's suite.
 *
 * Usage:
 *   tsx scripts/anvil-run.ts <hostname-dir> [--block <n>] [--port <p>] [--no-funding]
 *
 * Examples:
 *   tsx scripts/anvil-run.ts developer-avantisfi-com
 *   tsx scripts/anvil-run.ts app-uniswap-org --block 44530000
 *
 * Requires anvil (from Foundry) to be installed and on PATH.
 * Install: curl -L https://getfoundry.sh | bash && foundryup
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';
import { startAnvilFork } from '../src/agent/chain/anvil.js';
import { fundTestWallet, ANVIL_ACCOUNT_0 } from '../src/agent/chain/funding.js';
import { PROFILES } from '../src/agent/profiles/registry.js';

interface Args {
  hostname: string;
  block: number | null;
  port: number;
  noFunding: boolean;
  headless: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0].startsWith('--')) {
    console.error('usage: tsx scripts/anvil-run.ts <hostname-dir> [--block <n>] [--port <p>] [--no-funding] [--headless]');
    console.error('example: tsx scripts/anvil-run.ts developer-avantisfi-com');
    process.exit(1);
  }
  const hostname = argv[0];
  const args: Args = { hostname, block: null, port: 8545, noFunding: false, headless: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--block') args.block = Number(argv[++i]);
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--no-funding') args.noFunding = true;
    else if (argv[i] === '--headless') args.headless = true;
  }
  return args;
}

async function main() {
  const args = parseArgs();

  // Resolve the dApp profile by hostname folder name.
  const profile = PROFILES.find(p => new URL(p.url).hostname.replace(/\./g, '-') === args.hostname);
  if (!profile) {
    console.error(`no profile found for hostname "${args.hostname}"`);
    console.error(`available: ${PROFILES.map(p => new URL(p.url).hostname.replace(/\./g, '-')).join(', ')}`);
    process.exit(2);
  }

  const outputDir = join(process.cwd(), 'output', args.hostname);
  if (!existsSync(outputDir)) {
    console.error(`output dir not found: ${outputDir}`);
    console.error(`run spec-gen for this dApp first`);
    process.exit(3);
  }
  if (!existsSync(join(outputDir, 'playwright.config.ts'))) {
    console.error(`playwright.config.ts missing in ${outputDir} — run spec-gen first`);
    process.exit(4);
  }

  console.log(`━━━ Anvil-backed test run: ${profile.name} (${profile.archetype} / ${profile.network.chain}) ━━━\n`);

  let anvil;
  try {
    anvil = await startAnvilFork({
      chainId: profile.network.chainId,
      forkBlockNumber: args.block ?? undefined,
      port: args.port,
    });
  } catch (err: any) {
    console.error(`\nfailed to start anvil: ${err?.message ?? err}`);
    console.error(`\nif anvil is not installed, run:`);
    console.error(`  curl -L https://getfoundry.sh | bash`);
    console.error(`  foundryup`);
    process.exit(5);
  }

  // Pre-fund the test wallet with ETH and (where known) the profile's collateral token.
  if (!args.noFunding) {
    console.log(`[funding] test wallet ${ANVIL_ACCOUNT_0}`);
    // Derive sensible default token funding from the profile — USDC on Base/Eth/Arb is
    // the most common collateral token. Profiles that use other tokens should extend
    // the whale table in funding.ts.
    const defaultUsdcTokens = getDefaultCollateralTokens(profile.network.chainId);
    try {
      const result = await fundTestWallet(anvil.rpcUrl, {
        chainId: profile.network.chainId,
        wallet: ANVIL_ACCOUNT_0,
        eth: '100',
        tokens: defaultUsdcTokens,
      });
      const okCount = result.tokenResults.filter(r => r.ok).length;
      console.log(`[funding] funded with ${result.eth} ETH + ${okCount}/${result.tokenResults.length} token(s)`);
      for (const t of result.tokenResults) {
        console.log(`[funding]   ${t.ok ? '✓' : '✗'} ${t.symbol} — ${t.detail}`);
      }
    } catch (err: any) {
      console.warn(`[funding] best-effort funding failed: ${err?.message ?? err}`);
    }
  }

  // Route the chain verification layer at the fork for this process.
  process.env[`CHAIN_RPC_${profile.network.chainId}`] = anvil.rpcUrl;
  process.env.ANVIL_FORK_URL = anvil.rpcUrl;
  process.env.ANVIL_FORK_CHAIN_ID = String(profile.network.chainId);

  // Run Playwright against the generated suite.
  console.log(`\n[playwright] cd ${outputDir} && npx playwright test${args.headless ? ' (headless)' : ''}`);
  const pwArgs = ['playwright', 'test'];
  if (args.headless) pwArgs.push('--headed=false');
  const playwrightResult = await execa('npx', pwArgs, {
    cwd: outputDir,
    stdio: 'inherit',
    reject: false,
    env: {
      ...process.env,
      [`CHAIN_RPC_${profile.network.chainId}`]: anvil.rpcUrl,
      ANVIL_FORK_URL: anvil.rpcUrl,
      ANVIL_FORK_CHAIN_ID: String(profile.network.chainId),
    },
  });

  console.log(`\n[anvil] stopping fork on ${anvil.rpcUrl}`);
  await anvil.kill();

  process.exit(playwrightResult.exitCode ?? 0);
}

/**
 * Default collateral tokens per chain — the whale table in funding.ts covers the
 * USDC instances we use day-to-day. Profiles can override by adding their own
 * registerWhale() calls before scripts/anvil-run.ts is invoked.
 */
function getDefaultCollateralTokens(chainId: number): Array<{ address: `0x${string}`; amount: string; decimals: number; symbol: string }> {
  switch (chainId) {
    case 8453:
      return [{ address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '10000', decimals: 6, symbol: 'USDC.base' }];
    case 1:
      return [{ address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', amount: '10000', decimals: 6, symbol: 'USDC.eth' }];
    case 42161:
      return [{ address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', amount: '10000', decimals: 6, symbol: 'USDC.arb' }];
    case 10:
      return [{ address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', amount: '10000', decimals: 6, symbol: 'USDC.op' }];
    default:
      return [];
  }
}

main().catch(e => { console.error(e); process.exit(1); });

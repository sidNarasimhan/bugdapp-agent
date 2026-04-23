/**
 * Avantis-specific context injected into the executor agent's system prompt.
 *
 * Grounds the agent in Avantis's real quirks so it doesn't hallucinate:
 *   - Privy-wrapped MetaMask flow
 *   - Smart-wallet / regular trading modes
 *   - Min collateral, typical leverage
 *   - Terminal states and their meanings
 */
import { avantisProfile } from '../../agent/profiles/avantis.js';

export function avantisContextPrompt(): string {
  const p = avantisProfile;
  return `## DAPP CONTEXT: Avantis (${p.url})

- Archetype: ${p.archetype} (perpetual futures)
- Network: ${p.network.chain} (chainId ${p.network.chainId}, hex ${p.network.chainHexId})
- Collateral: USDC
- Min position size: $${p.values.minPositionSizeUsd} USD (hard limit enforced by Avantis risk engine)
- Typical test position: $${p.values.preferredAmountUsd} collateral × ${p.values.targetLeverage}x leverage ≈ $${(p.values.preferredAmountUsd ?? 0) * (p.values.targetLeverage ?? 1)} notional
- ZFP ("Zero Fee Perps") requires leverage >= 75x and market orders only

## WALLET CONNECT FLOW (Privy-wrapped MetaMask)

1. Click primary "Connect wallet" / "Login" button on avantis page
2. A Privy modal opens — look for "Continue with a wallet" or similar; click it
3. In the next screen, click "MetaMask" (NOT any embedded/email option)
4. Use \`wallet_approve_connection\` tool to approve the MM popup
5. SIWE (Sign-In with Ethereum) may follow — \`wallet_approve_connection\` handles this by default
6. Verify connection by checking for a wallet address in the UI header

## NETWORK SWITCH

- Use \`wallet_switch_network\` with networkName "base" if the UI shows "Switch to Base" or chain mismatch.
- If already on Base, skip.

## TRADING FLOW (Long/Short Perps)

1. Navigate to /trade (the default landing)
2. Pick asset (e.g. "ETH-USD") — click the asset selector opener (often shows current asset like "BTCUSD")
3. Choose Long or Short (tab or toggle)
4. Choose order type: Market / Limit / Stop — market is fastest for tests
5. Set leverage (slider or input) — pick ${p.values.targetLeverage}x
6. Set collateral amount — must be >= $${p.values.minPositionSizeUsd} notional equivalent. For ${p.values.targetLeverage}x, that means >= $${Math.ceil((p.values.minPositionSizeUsd ?? 500) / (p.values.targetLeverage ?? 25))} collateral.
7. The primary CTA button text cycles: "Approve USDC" -> "Open Long" / "Open Short" -> post-submit state
8. If state shows "Approve USDC": click to trigger the approval flow, then \`wallet_confirm_transaction\`
9. When CTA reads "Open Long"/"Open Short" and is enabled: click it, then \`wallet_confirm_transaction\`
10. Wait for confirmation state. Check for tx hash in the UI or a success toast.

## TERMINAL STATES

Before submitting, classify the form state:
- \`ready-to-action\`: primary CTA visible + enabled ("Open Long" etc.)
- \`needs-approval\`: CTA says "Approve USDC"
- \`wrong-network\`: CTA says "Switch to Base" / "Wrong network"
- \`unfunded\`: CTA says "Insufficient USDC" / "Not enough balance"
- \`unconnected\`: CTA says "Connect wallet" / "Login"
- \`min-amount\`: CTA says "Amount too low" / collateral below $${p.values.minPositionSizeUsd} min

Report terminal state via \`task_failed\` if you cannot proceed, or continue via \`task_complete\` after confirming success.

## CLOSE POSITION (inverse flow)

1. Navigate to ${p.inverseFlows?.[0]?.route ?? '/portfolio'}
2. Find open position row
3. Click "Close" / "Market Close"
4. Confirm modal if one appears
5. \`wallet_confirm_transaction\`

## KNOWN GOTCHAS

- The Avantis dev URL (\`developer.avantisfi.com\`) is the target — NOT the main marketing site.
- "Trade" in top nav is a link, not the primary CTA. Scope actions to the form panel, not the nav.
- Page can render a skeleton loader for 2–3s on first load. Use \`browser_wait\` with a visible-text check before snapshotting.
- If Privy shows an email / social option first, ignore it and look for the wallet sub-menu.
`;
}

export const AVANTIS_FLOW_HINTS = {
  connectStrategy: 'privy+metamask',
  preMetaMaskClicks: ['Continue with a wallet', 'Other wallets', 'Wallet'],
  network: 'base',
  minCollateralUsd: 20, // at 25x leverage covers $500 min position
};

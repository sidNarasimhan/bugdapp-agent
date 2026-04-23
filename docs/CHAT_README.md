# bugdapp-agent chat interface

Two ways to talk to the agent during BD meetings:

## 1. CLI chat (immediate, zero setup) — USE THIS TOMORROW

```bash
cd X:/bugdapp-agent
npx tsx src/chat/cli.ts
```

Looks and feels like a Discord DM in your terminal. Share your screen with the BD team, type slash commands, watch the agent respond with rich embedded messages.

**Commands:**
- `/help` — list all commands
- `/dapps` — show all 20 dApps with test counts
- `/report avantis` — show the regression report for Avantis
- `/coverage uniswap` — show what the suite tests on Uniswap
- `/run avantis` — execute a single representative test live (~15–60 sec)
- `/run avantis full` — run the entire Avantis suite (~30 min)
- `/run avantis trade` — run only specs matching "trade"
- `/findings` — aggregate findings across all dApps
- `/clear` — clear the screen
- `/exit` — quit

**Demo flow for a BD meeting:**
1. Open CLI. Greeting embed appears.
2. Type `/dapps` → shows coverage breadth (20 dApps, 7 chains, 7 archetypes).
3. Type `/report <their dapp>` → shows pre-generated findings.
4. Type `/coverage <their dapp>` → shows regression checkpoints, edge cases, inverse flows.
5. Type `/run avantis` → live test execution. MetaMask pops up, Avantis loads, form fills, terminal state classified. **15–60 seconds**.
6. Type `/findings` → shows aggregate bugs caught.

## 2. Discord bot (for "production" pitch after BD meetings)

Requires Discord app setup. Once set up, the CEO runs:

```bash
cd X:/bugdapp-agent
BUGDAPP_DISCORD_TOKEN="..." BUGDAPP_DISCORD_APP_ID="..." npx tsx src/chat/discord-bot.ts
```

Then in any channel the bot can see, type `/dapps`, `/report avantis`, etc. Same commands as the CLI.

### Discord setup (~10 minutes)

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → name it `bugdapp-agent`
3. Go to **Bot** tab → **Reset Token** → copy the token
4. Paste as `BUGDAPP_DISCORD_TOKEN` in `.env`
5. Go to **General Information** → copy the **Application ID**
6. Paste as `BUGDAPP_DISCORD_APP_ID` in `.env`
7. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Embed Links`, `Attach Files`, `Use Slash Commands`
8. Copy the generated URL → paste in browser → invite the bot to your server
9. Run `npx tsx src/chat/discord-bot.ts`
10. In Discord, type `/` in any channel — you should see `bugdapp-agent` commands autocomplete

### Why Discord for production pitch

Once deployed (on a server that's always up), the bot becomes the product's front door. Customers chat with it in their own Discord server, get regression reports on their dApps, trigger live runs. The CEO's pitch "the agent has already run on your dApp, I'll show you in Discord" becomes literally true.

## Environment requirements

Both interfaces need:
- `.env` with `SEED_PHRASE="..."` (test wallet)
- `metamask-extension/` directory in the repo root
- `output/<hostname>/` directories with `tests/`, `REPORT.md`, `README.md` (all pre-generated)

For `/run` to work, the target dApp's suite must have been generated via `npx tsx scripts/bulk-generate.ts` (already done for all 20).

## If something goes wrong during a live demo

- **`/run` hangs:** Ctrl+C out, say "let me come back to this one" — switch to `/report` which is instant.
- **MetaMask popup appears and blocks:** it's the fixture onboarding. First run on a fresh profile takes ~90 sec. Subsequent runs ~15 sec. If the meeting is short, pre-warm with one test run before the meeting.
- **Bot doesn't respond to slash commands:** global commands take up to 1 hour to propagate on first registration. Use guild-specific commands for instant testing (modify `discord-bot.ts`, swap `Routes.applicationCommands` for `Routes.applicationGuildCommands` with a guild ID).

## Architecture note

Both frontends (CLI + Discord) share the same command handlers in `src/chat/commands.ts`. Adding a new command means adding it there, and both interfaces pick it up automatically. The split is:
- `commands.ts` — command logic, context-agnostic (returns Embeds or strings)
- `formatter.ts` — ANSI rendering for the CLI
- `cli.ts` — readline REPL + ANSI output
- `discord-bot.ts` — discord.js slash commands + Embed conversion

This is the same pattern you'd use for Slack, Telegram, or any other chat frontend later — just add a new file that wraps `commands.ts`.

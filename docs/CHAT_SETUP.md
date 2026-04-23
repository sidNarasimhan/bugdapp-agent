# Chat Bot Setup (Discord + Slack + Notion)

One entry point runs any transport you've configured:

```bash
npm run bot
```

Talk to the bot and it will run tests + file findings.

---

## Commands

```
test trade flow on avantis     — run perps spec against avantis
run swap on aerodrome          — run swap spec
audit aave                     — run full suite
list                           — show available dApps
status                         — show active runs
help                           — command reference
```

Matching is fuzzy: "avantis", "avantisfi", "avantis.fi" all resolve to the same profile.

---

## Discord

1. https://discord.com/developers/applications → **New Application** → bot
2. **Bot** tab → reset token → copy → set `DISCORD_TOKEN` in `.env`
3. **Bot** tab → toggle **MESSAGE CONTENT INTENT** ON (privileged, required)
4. **OAuth2 → URL Generator** → scopes: `bot`, `applications.commands`; bot permissions: `Send Messages`, `Read Message History`, `View Channels` → open URL → add to your server
5. Either DM the bot or `@mention` it in a channel

---

## Slack (Socket Mode — no public URL)

1. https://api.slack.com/apps → **Create New App** (from scratch)
2. **Basic Information** → copy **Signing Secret** → `SLACK_SIGNING_SECRET`
3. **Basic Information → App-Level Tokens** → generate token with `connections:write` scope → `SLACK_APP_TOKEN` (starts `xapp-`)
4. **Socket Mode** → **Enable Socket Mode**
5. **OAuth & Permissions** → add bot scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write` → Install to workspace → copy **Bot User OAuth Token** → `SLACK_BOT_TOKEN` (starts `xoxb-`)
6. **Event Subscriptions** → enable → subscribe bot to: `app_mention`, `message.im`
7. Invite bot to channel: `/invite @botname`. DM works without invite.

---

## Notion

1. https://www.notion.so/my-integrations → **New integration** → internal → copy secret → `NOTION_TOKEN`
2. Create a new database with these exact properties:

    | Property     | Type      |
    |--------------|-----------|
    | Title        | Title     |
    | dApp         | Select    |
    | Archetype    | Select    |
    | Status       | Select    |
    | Spec         | Rich text |
    | Error        | Rich text |
    | URL          | URL       |
    | Ran at       | Date      |
    | Artifacts    | Rich text |

3. In the DB page: **…** menu → **Connections** → add your integration
4. Copy the DB ID from its URL (the 32-char hyphenated segment after your workspace) → `NOTION_DATABASE_ID`

If `NOTION_TOKEN` or `NOTION_DATABASE_ID` is missing, bots still run; failures are reported in chat only.

---

## `.env` additions

```
DISCORD_TOKEN=...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
NOTION_TOKEN=secret_...
NOTION_DATABASE_ID=...
```

Only fill the ones you want. Runner starts whichever transports are configured.

---

## Running

```bash
npm run bot
```

In another terminal, or on a server, that process must stay up. For production use a process manager (pm2, systemd, a small VM). No deployment automation is included in this repo.

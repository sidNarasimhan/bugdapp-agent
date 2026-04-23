#!/usr/bin/env npx tsx
/**
 * Entry point for the chat bots. Starts whichever transports are configured.
 *
 *   npm run bot
 *
 * Required env (at least one transport):
 *   DISCORD_TOKEN                          → enable Discord
 *   SLACK_BOT_TOKEN + SLACK_APP_TOKEN      → enable Slack (socket mode)
 *   SLACK_SIGNING_SECRET                   → required with Slack
 *
 * Optional env (findings filed if set):
 *   NOTION_TOKEN + NOTION_DATABASE_ID
 */
import 'dotenv/config';
import { startDiscordBot } from '../src/chat/discord-bot.js';
import { startSlackBot } from '../src/chat/slack-bot.js';

async function main() {
  console.log('━━━ bugdapp-agent bot runner ━━━');
  const [discord, slack] = await Promise.all([
    startDiscordBot().catch((e) => { console.error('[discord] start failed:', e?.message ?? e); return null; }),
    startSlackBot().catch((e) => { console.error('[slack] start failed:', e?.message ?? e); return null; }),
  ]);
  if (!discord && !slack) {
    console.error('No bot transport configured. Set DISCORD_TOKEN or SLACK_BOT_TOKEN+SLACK_APP_TOKEN+SLACK_SIGNING_SECRET in .env.');
    process.exit(1);
  }

  if (process.env.NOTION_TOKEN && process.env.NOTION_DATABASE_ID) {
    console.log('[notion] configured — findings will be filed');
  } else {
    console.log('[notion] not configured — failures will be reported in chat only');
  }

  process.on('SIGINT', async () => {
    console.log('\n[bot] shutting down');
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * Slack bot transport (Socket Mode — no public URL needed).
 *
 * Responds to:
 *   - DMs to the bot
 *   - @mentions in channels
 *
 * Env:
 *   SLACK_BOT_TOKEN       xoxb-... (from OAuth & Permissions)
 *   SLACK_APP_TOKEN       xapp-... (from App-Level Tokens, with connections:write)
 *   SLACK_SIGNING_SECRET  app signing secret
 *
 * Scopes:
 *   Bot: chat:write, app_mentions:read, im:history, im:read, im:write
 *   Event subscriptions: app_mention, message.im
 */
import App from '@slack/bolt';
import { handleMessage } from './handler.js';

export async function startSlackBot(): Promise<any | null> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!botToken || !appToken || !signingSecret) {
    console.log('[slack] tokens not set — skipping (need SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET)');
    return null;
  }

  const app = new App({
    token: botToken,
    appToken,
    signingSecret,
    socketMode: true,
  });

  const runFromEvent = async (text: string, say: any, channel: string, userId: string) => {
    const reply = async (m: string) => { await say({ text: m.slice(0, 3800), channel }); };
    const progress = async (m: string) => { await say({ text: m.slice(0, 3800), channel }); };
    const identity = { platform: 'slack' as const, userId, channelId: channel };
    try {
      await handleMessage(text, identity, { reply, progress });
    } catch (e: any) {
      await reply(`💥 error: ${e?.message ?? e}`);
    }
  };

  app.event('app_mention', async ({ event, say }: any) => {
    const text = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
    const uid = event.user ?? 'unknown';
    if (text) await runFromEvent(text, say, event.channel, uid);
  });

  app.message(async ({ message, say }: any) => {
    const m: any = message;
    if (m.channel_type !== 'im' || m.subtype || m.bot_id) return;
    const text = (m.text ?? '').trim();
    if (text) await runFromEvent(text, say, m.channel, m.user ?? 'unknown');
  });

  await app.start();
  console.log('[slack] socket-mode app started');
  return app;
}

/**
 * Discord bot transport.
 *
 * Responds to:
 *   - DMs
 *   - Channel mentions (@bot test trade flow on avantis)
 *
 * Env: DISCORD_TOKEN (required), DISCORD_APP_ID (optional, for app commands later).
 *
 * Required intents (enable in Discord Developer Portal):
 *   - MESSAGE CONTENT INTENT (privileged)
 */
import { Client, GatewayIntentBits, Events, Partials, type Message } from 'discord.js';
import { handleMessage } from './handler.js';

export async function startDiscordBot(): Promise<Client | null> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.log('[discord] DISCORD_TOKEN not set — skipping');
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.on(Events.ClientReady, (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (msg: Message) => {
    if (msg.author.bot) return;
    const isDM = msg.channel.isDMBased();
    const mention = client.user ? msg.mentions.has(client.user) : false;
    if (!isDM && !mention) return;

    const content = msg.content
      .replace(new RegExp(`<@!?${client.user?.id}>`, 'g'), '')
      .trim();
    if (!content) return;

    const reply = (m: string) => msg.reply({ content: m.slice(0, 1990) }).then(() => undefined);
    const progress = (m: string) => {
      const ch: any = msg.channel;
      if (typeof ch?.send === 'function') {
        return ch.send({ content: m.slice(0, 1990) }).catch(() => undefined).then(() => undefined);
      }
      return Promise.resolve();
    };

    const identity = {
      platform: 'discord' as const,
      userId: msg.author.id,
      channelId: msg.channelId,
    };

    try {
      await handleMessage(content, identity, { reply, progress });
    } catch (e: any) {
      await reply(`💥 error: ${e?.message ?? e}`);
    }
  });

  await client.login(token);
  return client;
}

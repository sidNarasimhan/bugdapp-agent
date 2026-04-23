#!/usr/bin/env npx tsx
/**
 * Local CLI harness for the chat agent. Lets you test the full
 * parse → match → plan → approve → execute → report loop
 * WITHOUT needing Discord/Slack tokens.
 *
 *   npm run chat
 *
 * Type messages. Approve runs with `go`. Quit with `/quit` or Ctrl+C.
 */
import 'dotenv/config';
import * as readline from 'readline';
import { handleMessage, type Identity, type ReplyFns } from '../src/chat/handler.js';
import { resetSession } from '../src/chat/agent/session.js';

const identity: Identity = {
  platform: 'discord', // any — just for pending-approval keying
  userId: 'cli',
  channelId: 'local',
};

const io: ReplyFns = {
  reply: async (m: string) => { console.log(`\n🤖 ${m}\n`); },
  progress: async (m: string) => {
    const clean = m.replace(/^```\n?|\n?```$/g, '').trim();
    if (clean) console.log(`   ${clean}`);
  },
};

async function main() {
  console.log('━━━ bugdapp-agent chat CLI ━━━');
  console.log('Type tasks, approve with `go`, quit with /quit.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('you > ');
  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (text === '/quit' || text === '/exit') {
      rl.close();
      return;
    }
    if (text === '/reset') {
      await resetSession();
      console.log('browser session reset.\n');
      rl.prompt();
      return;
    }
    if (!text) { rl.prompt(); return; }
    try {
      await handleMessage(text, identity, io);
    } catch (e: any) {
      console.error(`💥 handler crashed: ${e?.message ?? e}`);
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    console.log('\nshutting down...');
    await resetSession();
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });

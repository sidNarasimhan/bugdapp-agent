#!/usr/bin/env npx tsx
/**
 * No-LLM browser smoke test. Launches Chromium + MM + navigates + snapshots.
 * Reports what happened. Safe to delete after use.
 */
import 'dotenv/config';
import { getOrLaunchSession, resetSession } from '../src/chat/agent/session.js';
import { routeToolCall } from '../src/chat/agent/tool-router.js';
import { avantisProfile } from '../src/agent/profiles/avantis.js';

async function main() {
  const started = Date.now();
  console.log('[smoke] step 1: launch session + navigate to', avantisProfile.url);
  const ctx = await getOrLaunchSession(avantisProfile.url);
  console.log(`[smoke] session ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`[smoke] page.url=${ctx.page.url()}`);
  console.log(`[smoke] page.title=${await ctx.page.title()}`);

  console.log('[smoke] step 2: snapshot');
  const snap = await routeToolCall('browser_snapshot', {}, ctx);
  console.log(`[smoke] snapshot success=${snap.success} bytes=${snap.output.length}`);
  console.log(`[smoke] snapshot preview (first 400 chars):\n${snap.output.slice(0, 400)}`);

  console.log('[smoke] step 3: screenshot');
  const shot = await routeToolCall('browser_screenshot', { name: 'smoke-avantis' }, ctx);
  console.log(`[smoke] ${shot.output}`);

  console.log('[smoke] step 4: teardown');
  await resetSession();
  console.log(`[smoke] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error('[smoke] FAILED:', e?.message ?? e); process.exit(1); });

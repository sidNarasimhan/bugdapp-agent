import { describe, it, expect } from 'vitest';
import { parseCommand } from '../src/chat/commands.js';
import { classifyReply } from '../src/chat/approvals.js';

describe('parseCommand', () => {
  it('resolves "test trade flow on avantis" to perps run', () => {
    const c = parseCommand('test trade flow on avantis');
    expect(c.kind).toBe('run');
    if (c.kind === 'run') {
      expect(c.dApp.name.toLowerCase()).toContain('avantis');
      expect(c.filter).toBe('perps');
    }
  });

  it('resolves "run swap on aerodrome"', () => {
    const c = parseCommand('run swap on aerodrome');
    expect(c.kind).toBe('run');
    if (c.kind === 'run') {
      expect(c.filter).toBe('swap');
      expect(c.dApp.name.toLowerCase()).toContain('aerodrome');
    }
  });

  it('"audit aave" = full suite on aave', () => {
    const c = parseCommand('audit aave');
    expect(c.kind).toBe('run');
    if (c.kind === 'run') {
      expect(c.filter).toBe('all');
      expect(c.dApp.name.toLowerCase()).toContain('aave');
    }
  });

  it('"help" returns help', () => {
    expect(parseCommand('help').kind).toBe('help');
  });

  it('"list" returns list', () => {
    expect(parseCommand('list').kind).toBe('list');
  });

  it('unknown dApp returns unknown', () => {
    const c = parseCommand('test swap on notarealdapp');
    expect(c.kind).toBe('unknown');
  });
});

describe('classifyReply', () => {
  it.each(['go', 'yes', 'approved', 'LGTM', '👍', 'ship', 'ok'])('approves %s', (s) => {
    expect(classifyReply(s)).toBe('approve');
  });
  it.each(['no', 'cancel', 'stop', 'abort', 'nope'])('rejects %s', (s) => {
    expect(classifyReply(s)).toBe('reject');
  });
  it('returns null for unrelated', () => {
    expect(classifyReply('what time is it')).toBe(null);
  });
});

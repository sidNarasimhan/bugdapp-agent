import { describe, it, expect } from 'vitest';
import { CostTracker } from '../src/llm/cost-tracker.js';

describe('CostTracker', () => {
  it('tracks usage across multiple calls', () => {
    const tracker = new CostTracker('anthropic/claude-sonnet-4');

    tracker.recordUsage({ input_tokens: 1000, output_tokens: 200 });
    tracker.recordUsage({ input_tokens: 500, output_tokens: 100 });

    const summary = tracker.getSummary();
    expect(summary.totalApiCalls).toBe(2);
    expect(summary.inputTokens).toBe(1500);
    expect(summary.outputTokens).toBe(300);
  });

  it('estimates cost for claude-sonnet-4', () => {
    const tracker = new CostTracker('anthropic/claude-sonnet-4');
    // 1M input tokens @ $3, 1M output tokens @ $15
    tracker.recordUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 });

    const cost = tracker.estimateCost();
    expect(cost).toBeCloseTo(18, 1); // $3 + $15
  });

  it('estimates cost for haiku', () => {
    const tracker = new CostTracker('anthropic/claude-haiku-4-5');
    tracker.recordUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 });

    const cost = tracker.estimateCost();
    expect(cost).toBeCloseTo(4.8, 1); // $0.80 + $4
  });

  it('falls back to sonnet pricing for unknown models', () => {
    const tracker = new CostTracker('some/unknown-model');
    tracker.recordUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 });

    const cost = tracker.estimateCost();
    expect(cost).toBeCloseTo(18, 1); // Falls back to sonnet
  });

  it('merges two trackers', () => {
    const a = new CostTracker('anthropic/claude-sonnet-4');
    a.recordUsage({ input_tokens: 1000, output_tokens: 100 });

    const b = new CostTracker('anthropic/claude-sonnet-4');
    b.recordUsage({ input_tokens: 2000, output_tokens: 200 });

    a.merge(b);

    const summary = a.getSummary();
    expect(summary.totalApiCalls).toBe(2);
    expect(summary.inputTokens).toBe(3000);
    expect(summary.outputTokens).toBe(300);
  });

  it('formats as string', () => {
    const tracker = new CostTracker('anthropic/claude-sonnet-4');
    tracker.recordUsage({ input_tokens: 5000, output_tokens: 1000 });

    const str = tracker.toString();
    expect(str).toContain('1 calls');
    expect(str).toContain('6000 tokens');
    expect(str).toContain('$');
  });
});

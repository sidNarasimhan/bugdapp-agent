// Pricing per million tokens — OpenRouter (as of 2025)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'anthropic/claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'anthropic/claude-sonnet-4.6': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'anthropic/claude-haiku-4.5': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'anthropic/claude-haiku-4-5': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'google/gemini-2.5-flash': { input: 0.30, output: 2.50, cacheRead: 0.075, cacheWrite: 0.30 },
  'google/gemini-2.5-flash-lite': { input: 0.10, output: 0.40, cacheRead: 0.025, cacheWrite: 0.10 },
  'openai/gpt-4o': { input: 2.50, output: 10, cacheRead: 1.25, cacheWrite: 2.50 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: 0.15 },
  'deepseek/deepseek-chat-v3-0324': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek/deepseek-chat': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
};

export interface UsageSummary {
  totalApiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
}

export class CostTracker {
  private model: string;
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheCreationTokens = 0;

  constructor(model: string) {
    this.model = model;
  }

  recordUsage(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }): void {
    this.calls++;
    this.inputTokens += usage.input_tokens || 0;
    this.outputTokens += usage.output_tokens || 0;
    this.cacheReadTokens += usage.cache_read_input_tokens || 0;
    this.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
  }

  estimateCost(): number {
    const pricing = PRICING[this.model] || PRICING['anthropic/claude-sonnet-4'];
    const inputCost = (this.inputTokens / 1_000_000) * pricing.input;
    const outputCost = (this.outputTokens / 1_000_000) * pricing.output;
    const cacheReadCost = (this.cacheReadTokens / 1_000_000) * pricing.cacheRead;
    const cacheWriteCost = (this.cacheCreationTokens / 1_000_000) * pricing.cacheWrite;
    return inputCost + outputCost + cacheReadCost + cacheWriteCost;
  }

  getSummary(): UsageSummary {
    return {
      totalApiCalls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      estimatedCostUsd: this.estimateCost(),
    };
  }

  toString(): string {
    const s = this.getSummary();
    return `${s.totalApiCalls} calls, ${s.inputTokens + s.outputTokens} tokens, ~$${s.estimatedCostUsd.toFixed(3)}`;
  }

  merge(other: CostTracker): void {
    const s = other.getSummary();
    this.calls += s.totalApiCalls;
    this.inputTokens += s.inputTokens;
    this.outputTokens += s.outputTokens;
    this.cacheReadTokens += s.cacheReadTokens;
    this.cacheCreationTokens += s.cacheCreationTokens;
  }
}

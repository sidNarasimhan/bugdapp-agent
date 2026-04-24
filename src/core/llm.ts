import OpenAI from 'openai';

// ---------- Anthropic-compatible types ----------

export interface ContentBlockText {
  type: 'text';
  text: string;
}

export interface ContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = ContentBlockText | ContentBlockToolUse;

export interface ToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlock[] | ToolResultBlockParam[];
}

export interface ToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string | { type: 'text'; text: string; cache_control?: unknown }[];
  tools?: ToolParam[];
  messages: MessageParam[];
}

export interface MessageResponse {
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// ---------- Client ----------

export class OpenRouterClient {
  private client: OpenAI;

  constructor(opts: { apiKey: string; baseURL?: string }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL || 'https://openrouter.ai/api/v1',
    });
  }

  messages = {
    create: async (params: MessageCreateParams): Promise<MessageResponse> => {
      const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      // System prompt. If caller passed an array of text blocks (with optional
      // cache_control markers), forward them as content blocks so OpenRouter
      // translates to Anthropic ephemeral cache. Otherwise plain string.
      if (Array.isArray(params.system)) {
        const blocks = params.system.map(s => ({
          type: 'text' as const,
          text: s.text,
          ...(s.cache_control ? { cache_control: s.cache_control } : {}),
        }));
        openaiMessages.push({ role: 'system', content: blocks as any });
      } else if (typeof params.system === 'string' && params.system) {
        openaiMessages.push({ role: 'system', content: params.system });
      }

      for (const msg of params.messages) {
        if (msg.role === 'user') {
          if (typeof msg.content === 'string') {
            openaiMessages.push({ role: 'user', content: msg.content });
          } else if (Array.isArray(msg.content)) {
            const first = msg.content[0];
            if (first && 'type' in first && (first as any).type === 'tool_result') {
              for (const block of msg.content as ToolResultBlockParam[]) {
                openaiMessages.push({
                  role: 'tool',
                  tool_call_id: block.tool_use_id,
                  content: block.content,
                });
              }
            } else {
              const text = (msg.content as ContentBlock[])
                .filter((b): b is ContentBlockText => b.type === 'text')
                .map((b) => b.text)
                .join('\n');
              if (text) {
                openaiMessages.push({ role: 'user', content: text });
              }
            }
          }
        } else if (msg.role === 'assistant') {
          if (typeof msg.content === 'string') {
            openaiMessages.push({ role: 'assistant', content: msg.content });
          } else if (Array.isArray(msg.content)) {
            const blocks = msg.content as ContentBlock[];
            const textParts = blocks
              .filter((b): b is ContentBlockText => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
            const toolUses = blocks.filter(
              (b): b is ContentBlockToolUse => b.type === 'tool_use'
            );

            if (toolUses.length > 0) {
              openaiMessages.push({
                role: 'assistant',
                content: textParts || null,
                tool_calls: toolUses.map((t) => ({
                  id: t.id,
                  type: 'function' as const,
                  function: {
                    name: t.name,
                    arguments: JSON.stringify(t.input),
                  },
                })),
              });
            } else {
              openaiMessages.push({
                role: 'assistant',
                content: textParts || '',
              });
            }
          }
        }
      }

      const openaiTools: OpenAI.Chat.ChatCompletionTool[] | undefined =
        params.tools?.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        }));

      // Retry with exponential backoff for transient network errors
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await this.client.chat.completions.create({
            model: params.model,
            max_tokens: params.max_tokens,
            temperature: params.temperature,
            messages: openaiMessages,
            tools: openaiTools,
          });
          return this.mapResponse(response);
        } catch (e: any) {
          lastError = e;
          const isRetryable = /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|502|503|529/i.test(String(e.message || e));
          if (!isRetryable || attempt === 2) throw e;
          const delay = (attempt + 1) * 5000;
          console.warn(`[OpenRouter] Retry ${attempt + 1}/3 after ${delay}ms: ${String(e.message).substring(0, 80)}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      throw lastError!;
    },
  };

  private extractSystemPrompt(
    system?: string | { type: 'text'; text: string; cache_control?: unknown }[]
  ): string | null {
    if (!system) return null;
    if (typeof system === 'string') return system;
    return system.map((s) => s.text).join('\n');
  }

  private mapResponse(response: OpenAI.Chat.ChatCompletion): MessageResponse {
    const choice = response.choices[0];
    if (!choice) {
      return {
        content: [{ type: 'text', text: 'No response from model' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }

    const content: ContentBlock[] = [];

    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      for (const tc of choice.message.tool_calls) {
        const fn = (tc as any).function;
        if (!fn) continue;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(fn.arguments);
        } catch {
          input = { _raw: fn.arguments };
        }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: fn.name,
          input,
        });
      }
    }

    let stop_reason: string = 'end_turn';
    if (choice.finish_reason === 'tool_calls') {
      stop_reason = 'tool_use';
    } else if (choice.finish_reason === 'length') {
      stop_reason = 'max_tokens';
    } else if (choice.finish_reason === 'stop') {
      stop_reason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    }

    // OpenRouter forwards Anthropic cache metrics via non-standard usage fields.
    // Different provider routes may surface them under different names; we probe
    // the common ones and default to 0.
    const u = response.usage as any;
    const cacheRead = u?.cache_read_input_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheCreation = u?.cache_creation_input_tokens ?? 0;

    return {
      content,
      stop_reason,
      usage: {
        input_tokens: u?.prompt_tokens || 0,
        output_tokens: u?.completion_tokens || 0,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    };
  }
}

export function createOpenRouterClient(apiKey?: string): OpenRouterClient {
  const key = apiKey || process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error('OpenRouter API key required. Set OPENROUTER_API_KEY env var.');
  }
  return new OpenRouterClient({ apiKey: key });
}

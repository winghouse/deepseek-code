// ============================================================
// Model Adapter — DeepSeek API（OpenAI 兼容格式）
// ============================================================

import type { ChatMessage, ModelResponse, ToolCall, TokenUsage } from 'deepseek-code-shared';
import type { ChatOptions, DeepSeekConfig, ModelClient } from './types.js';

export class DeepSeekClient implements ModelClient {
  readonly modelName: string;
  private config: DeepSeekConfig;

  constructor(modelName: string, config: DeepSeekConfig) {
    this.modelName = modelName;
    this.config = {
      baseUrl: 'https://api.deepseek.com',
      timeout: 180_000,
      ...config,
    };
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ModelResponse> {
    const url = `${this.config.baseUrl}/v1/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens,
      stream: false,
    };

    if (options?.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = options.toolChoice ?? 'auto';
    }

    // DeepSeek V4: JSON 模式 + 推理深度 + thinking 控制 (独立于 tools)
    if (options?.responseFormat) body.response_format = { type: options.responseFormat };
    if (options?.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
    if (options?.disableThinking) body.thinking = { type: 'disabled' };

    let lastError = null;
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeout);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok && attempt < maxRetries && (response.status === 429 || response.status >= 500)) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          await new Promise(r => setTimeout(r, delay));
          lastError = new Error(`DeepSeek API ${response.status} (retry ${attempt+1}/${maxRetries})`);
          continue;
        }
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`DeepSeek API error ${response.status}: ${text}`);
        }
        const data = (await response.json()) as Record<string, unknown>;
        const choice = (data.choices as Array<{ message?: { content?: string; tool_calls?: unknown }; finish_reason?: string }>)?.[0];
        const message = choice?.message;
        return {
          content: message?.content ?? null,
          tool_calls: this.parseToolCalls(message?.tool_calls),
          finish_reason: (choice?.finish_reason as ModelResponse['finish_reason']) ?? 'stop',
          usage: this.parseUsage(data.usage),
        };
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error("DeepSeek API: 重试耗尽");
  }

  async *chatStream(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<string, void, unknown> {
    const url = `${this.config.baseUrl}/v1/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options?.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = options?.toolChoice ?? 'auto';
    }

    if (options?.disableThinking) {
      body.thinking = { type: 'disabled' };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${text}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
  }

  // ---- helpers ----

  private parseToolCalls(raw: unknown): ToolCall[] | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.map((tc: Record<string, unknown>) => ({
      id: tc.id as string,
      type: 'function' as const,
      function: {
        name: (tc.function as Record<string, string>)?.name ?? '',
        arguments:
          typeof (tc.function as Record<string, unknown>)?.arguments === 'string'
            ? ((tc.function as Record<string, string>).arguments as string)
            : JSON.stringify((tc.function as Record<string, unknown>)?.arguments ?? {}),
      },
    }));
  }

  private parseUsage(raw: unknown): TokenUsage {
    const u = raw as Record<string, number> | undefined;
    return {
      prompt_tokens: u?.prompt_tokens ?? 0,
      completion_tokens: u?.completion_tokens ?? 0,
      total_tokens: u?.total_tokens ?? 0,
      cache_hit_tokens: u?.prompt_cache_hit_tokens ?? u?.cache_hit_tokens,
    };
  }
}

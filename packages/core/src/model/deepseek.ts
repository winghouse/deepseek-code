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

  /**
   * 流式 chat — 文本实时打印，tool_calls 缓冲后返回完整 ModelResponse。
   * 用于 Agent Loop 替代 blocking model.chat()，解决 44s spinner 等待。
   */
  async chatWithStreamingText(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ModelResponse> {
    try {
      return await this._chatWithStreamingText(messages, options);
    } catch {
      // 流式失败 → fallback 到非流式 chat()
      return this.chat(messages, options);
    }
  }

  private async _chatWithStreamingText(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ModelResponse> {
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
      body.tools = options.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = options?.toolChoice ?? 'auto';
    }
    if (options?.responseFormat) body.response_format = { type: options.responseFormat };
    if (options?.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
    if (options?.disableThinking) body.thinking = { type: 'disabled' };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`DeepSeek API error ${response.status}: ${await response.text()}`);

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '', textContent = '';
    const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: ModelResponse['finish_reason'] = 'stop';
    let usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let shownTextLength = 0, hasToolCalls = false;

    // 思考计时器: 模型推理期间显示耗时，首次输出后自动清除
    const thinkingStart = Date.now();
    const thinkingTimer = setInterval(() => {
      process.stdout.write(`\r⏳ 思考中... ${Math.floor((Date.now() - thinkingStart) / 1000)}s`);
    }, 500);
    let thinkingActive = true;
    const stopThinking = () => {
      if (!thinkingActive) return;
      thinkingActive = false;
      clearInterval(thinkingTimer);
      process.stdout.write('\r' + ' '.repeat(30) + '\r');
    };

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
          const delta = json.choices?.[0]?.delta;

          // finish_reason/usage 可能在无 delta 的独立 chunk 中
          if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason as ModelResponse['finish_reason'];
          if (json.usage) usage = this.parseUsage(json.usage);

          if (!delta) continue;

          // 首次有意义输出 → 停止思考计时器
          if (thinkingActive && (delta.content || delta.tool_calls)) stopThinking();

          // 工具调用首次出现 → 清屏已打印的半成品文本
          if (delta.tool_calls && !hasToolCalls) {
            hasToolCalls = true;
            if (shownTextLength > 0) process.stdout.write('\r' + ' '.repeat(60) + '\r');
            process.stdout.write('💭 正在选择工具...');
          }

          // 文本只在无工具调用时实时打印
          if (delta.content && !hasToolCalls) {
            textContent += delta.content;
            const newText = textContent.slice(shownTextLength);
            if (newText) { process.stdout.write(newText); shownTextLength = textContent.length; }
          }

          // tool_calls: 按 index 聚合分片
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallsMap.get(idx) || { id: '', name: '', args: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
              toolCallsMap.set(idx, existing);
            }
          }

        } catch { /* skip malformed */ }
      }
    }

    stopThinking(); // 流结束后兜底清除计时器

    if (hasToolCalls) process.stdout.write('\n');
    else if (shownTextLength > 0) process.stdout.write('\n');

    const toolCalls: ToolCall[] = [...toolCallsMap.values()]
      .filter(tc => tc.id && tc.name)
      .map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.args } }));

    return {
      content: textContent || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      finish_reason: finishReason,
      usage: usage.total_tokens === 0
        ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        : usage,
    };
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
      cache_miss_tokens: u?.prompt_cache_miss_tokens ?? u?.cache_miss_tokens,
    };
  }
}

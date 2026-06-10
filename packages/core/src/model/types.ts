// ============================================================
// Model Adapter — 内部类型
// ============================================================

import type { ChatMessage, ModelResponse, ToolDefinition } from 'deepseek-code-shared';

/** 模型客户端接口 —— 所有模型适配器必须实现 */
export interface ModelClient {
  /** 模型名称 */
  readonly modelName: string;

  /** 发送 chat completion 请求 */
  chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ModelResponse>;

  /** 发送 chat completion 请求（流式） */
  chatStream(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<string, void, unknown>;
}

/** Chat 请求选项 */
export interface ChatOptions {
  /** 可用工具列表 */
  tools?: ToolDefinition[];
  /** 温度参数 */
  temperature?: number;
  /** 最大输出 token */
  maxTokens?: number;
  /** 强制使用工具 */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  /** 系统提示词（如果不放在 messages 里） */
  systemPrompt?: string;
  /** JSON 模式 (DeepSeek V4 response_format) */
  responseFormat?: 'json_object' | 'text';
  /** 推理深度 (DeepSeek V4-Pro reasoning_effort) */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** 禁用 thinking (Flash 模型默认开启 thinking, 会消耗 output tokens) */
  disableThinking?: boolean;
}

/** DeepSeek API 配置 */
export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

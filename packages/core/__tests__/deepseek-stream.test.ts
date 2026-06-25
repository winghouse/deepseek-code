// ============================================================
// chatWithStreamingText 流式专项测试
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

// 模拟 SSE 流 — 接受多段 data lines + optional usage
function mockSSEStream(...chunks: Array<Record<string, unknown>>): ReadableStream {
  const encoder = new TextEncoder();
  const lines = chunks.map(c => `data: ${JSON.stringify(c)}\n`).join('') + 'data: [DONE]\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

async function readFullStream(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += new TextDecoder().decode(value);
  }
  return result;
}

// 由于 deepseek.ts 是 ESM 且内部直接 fetch，用 mock 测试
describe('chatWithStreamingText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══ 1. 文本流式 ═══
  it('多段 content 拼接成完整文本', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: mockSSEStream(
        { choices: [{ delta: { content: 'hello' } }] },
        { choices: [{ delta: { content: ' world' } }] },
        { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ),
    });

    const { DeepSeekClient } = await import('../src/model/deepseek.js');
    const client = new DeepSeekClient('deepseek-v4-pro', { apiKey: 'test', baseUrl: 'https://test' });
    const resp = await client.chatWithStreamingText([{ role: 'user', content: 'hi' }]);

    expect(resp.content).toBe('hello world');
    expect(resp.finish_reason).toBe('stop');
    expect(resp.tool_calls).toBeNull();
  });

  // ═══ 2. tool_calls 分片 ═══
  it('tool_calls 按 index 聚合分片 arguments', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: mockSSEStream(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"filePath":"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'package.json"}' } }] } }] },
        { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ),
    });

    const { DeepSeekClient } = await import('../src/model/deepseek.js');
    const client = new DeepSeekClient('deepseek-v4-pro', { apiKey: 'test', baseUrl: 'https://test' });
    const resp = await client.chatWithStreamingText([{ role: 'user', content: 'read package.json' }]);

    expect(resp.finish_reason).toBe('tool_calls');
    expect(resp.tool_calls).toHaveLength(1);
    expect(resp.tool_calls![0].function.name).toBe('read_file');
    expect(resp.tool_calls![0].function.arguments).toBe('{"filePath":"package.json"}');
  });

  // ═══ 3. 文本转工具 ═══
  it('先文本后工具 → content保留, finish_reason=tool_calls', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: mockSSEStream(
        { choices: [{ delta: { content: 'Let me read that file...' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{}' } }] } }] },
        { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } },
      ),
    });

    const { DeepSeekClient } = await import('../src/model/deepseek.js');
    const client = new DeepSeekClient('deepseek-v4-pro', { apiKey: 'test', baseUrl: 'https://test' });
    const resp = await client.chatWithStreamingText([{ role: 'user', content: 'test' }]);

    expect(resp.finish_reason).toBe('tool_calls');
    expect(resp.content).toContain('Let me read');
    expect(resp.tool_calls).toHaveLength(1);
  });

  // ═══ 4. usage 缺失 ═══
  it('usage 缺失 → 安全默认值, 不 NaN', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: mockSSEStream(
        { choices: [{ delta: { content: 'done' } }] },
        { choices: [{ finish_reason: 'stop' }] },
        // 无 usage
      ),
    });

    const { DeepSeekClient } = await import('../src/model/deepseek.js');
    const client = new DeepSeekClient('deepseek-v4-pro', { apiKey: 'test', baseUrl: 'https://test' });
    const resp = await client.chatWithStreamingText([{ role: 'user', content: 'test' }]);

    expect(resp.usage).toBeDefined();
    expect(resp.usage.total_tokens).toBe(0);
    expect(resp.usage.prompt_tokens).toBe(0);
    expect(isNaN(resp.usage.completion_tokens)).toBe(false);
  });

  // ═══ 5. 流式异常 fallback ═══
  it('流式失败 → fallback 到非流式 chat()', async () => {
    // 第一次: 流式失败
    mockFetch
      .mockRejectedValueOnce(new Error('SSE error'))
      // 第二次: fallback 非流式成功
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'fallback response' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      });

    const { DeepSeekClient } = await import('../src/model/deepseek.js');
    const client = new DeepSeekClient('deepseek-v4-pro', { apiKey: 'test', baseUrl: 'https://test' });
    const resp = await client.chatWithStreamingText([{ role: 'user', content: 'test' }]);

    expect(resp.content).toBe('fallback response');
    expect(resp.finish_reason).toBe('stop');
    expect(resp.usage.total_tokens).toBe(7);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ═══ 6. 多 tool_calls 不同 index ═══
  it('多 tool_calls 不同 index 正确分离', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: mockSSEStream(
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{}' } },
          { index: 1, id: 'call_2', function: { name: 'search_code', arguments: '{"pattern":"bug"}' } },
        ] } }] },
        { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
      ),
    });

    const { DeepSeekClient } = await import('../src/model/deepseek.js');
    const client = new DeepSeekClient('deepseek-v4-pro', { apiKey: 'test', baseUrl: 'https://test' });
    const resp = await client.chatWithStreamingText([{ role: 'user', content: 'test' }]);

    expect(resp.tool_calls).toHaveLength(2);
    expect(resp.tool_calls![0].function.name).toBe('read_file');
    expect(resp.tool_calls![1].function.name).toBe('search_code');
  });
});

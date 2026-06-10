import { describe, it, expect } from 'vitest';
import { continueLoop } from '../src/agent/loop.js';
import { InMemoryStore } from '../src/context/memory.js';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../src/tools/definitions.js';
import { createToolExecutors } from '../src/tools/executors.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatMessage, Session, ToolCall, ModelResponse } from 'deepseek-code-shared';
import type { ModelClient, ChatOptions } from '../src/model/types.js';

// ═══ Mock Model: 可控响应 ═══
function mockModel(responses: ModelResponse[]): ModelClient {
  let idx = 0;
  return {
    modelName: 'mock',
    async chat(_msgs: ChatMessage[], _opts?: ChatOptions): Promise<ModelResponse> {
      return responses[idx++] ?? {
        content: 'done', tool_calls: null, finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
    async *chatStream(): AsyncGenerator<string> {
      // 模拟流式不可用 → Agent 自动降级到 chat()
      throw new Error('mock: stream not supported');
    },
  };
}

function makeSession(): Session {
  return {
    id: 'test-' + Date.now(),
    createdAt: new Date(), taskDescription: 'test', modelName: 'mock',
    workingDir: os.tmpdir(), steps: [], completed: false,
    phase: 'analyzing', mode: 'readonly',
    appliedPatches: [], commandHistory: [], knownFiles: [], toolResultsCache: {},
  };
}

describe('continueLoop', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscode-loop-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('工具调用 → 最终回答', async () => {
    // 准备测试文件
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Test\nhello world\n', 'utf-8');

    const model = mockModel([
      // Step 1: 调用 read_file
      {
        content: 'let me read',
        tool_calls: [{
          id: 'call_1', type: 'function',
          function: { name: 'read_file', arguments: '{"filePath":"readme.md"}' },
        }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      // Step 2: 最终回答
      {
        content: '文件内容是 hello world',
        tool_calls: null,
        finish_reason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      },
    ]);

    const tools = createToolExecutors({ workingDir: tmpDir });
    const memory = new InMemoryStore();
    const session = makeSession();
    const messages: ChatMessage[] = [
      { role: 'system', content: 'test' },
      { role: 'user', content: 'read readme' },
    ];

    const result = await continueLoop(
      session, messages, model, READ_ONLY_TOOLS,
      tmpDir, tools, memory, undefined, true, false,
      Date.now(), 20, undefined,
    );

    expect(result.success).toBe(true);
    expect(result.session.steps.length).toBeGreaterThan(0);
    const finalStep = result.session.steps.find((s) => s.type === 'final');
    expect(finalStep).toBeDefined();
    expect(finalStep?.content).toContain('hello world');
  });

  it('readonly 模式拦截写工具', async () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# test\n', 'utf-8');

    const model = mockModel([
      {
        content: 'let me write',
        tool_calls: [{
          id: 'call_1', type: 'function',
          function: { name: 'run_command', arguments: '{"command":"echo test"}' },
        }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        content: 'blocked, I will just read',
        tool_calls: [{
          id: 'call_2', type: 'function',
          function: { name: 'read_file', arguments: '{"filePath":"readme.md"}' },
        }],
        finish_reason: 'tool_calls',
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
      {
        content: 'analysis done', tool_calls: null, finish_reason: 'stop',
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      },
    ]);

    const tools = createToolExecutors({ workingDir: tmpDir });
    const memory = new InMemoryStore();
    const session = makeSession();
    const messages: ChatMessage[] = [{ role: 'system', content: 'test' }, { role: 'user', content: 'run cmd' }];

    const result = await continueLoop(
      session, messages, model, READ_ONLY_TOOLS,
      tmpDir, tools, memory, undefined, true, false,
      Date.now(), 20, undefined,
    );

    expect(result.success).toBe(true);

    // run_command 应被拦截
    const blockedSteps = result.session.steps.filter((s) =>
      s.toolResults?.some((r) => r.error === 'READONLY_TOOL_BLOCKED'),
    );
    expect(blockedSteps.length).toBeGreaterThan(0);

    // 之后仍然可以正常执行 read_file
    const readSteps = result.session.steps.filter((s) =>
      s.toolResults?.some((r) => r.success),
    );
    expect(readSteps.length).toBeGreaterThan(0);
  });

  it('连续读相同文件触发无进展停止', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b\n', 'utf-8');

    const readA = (id: string): ToolCall => ({
      id, type: 'function',
      function: { name: 'read_file', arguments: `{"filePath":"a.txt"}` },
    });
    const readB = (id: string): ToolCall => ({
      id, type: 'function',
      function: { name: 'read_file', arguments: `{"filePath":"b.txt"}` },
    });

    const model = mockModel([
      { content: '', tool_calls: [readA('c1')], finish_reason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
      { content: '', tool_calls: [readA('c2')], finish_reason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
      { content: '', tool_calls: [readA('c3')], finish_reason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
      { content: '', tool_calls: [readA('c4')], finish_reason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
      { content: 'should not reach', tool_calls: [readB('c5')], finish_reason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
    ]);

    const tools = createToolExecutors({ workingDir: tmpDir });
    const memory = new InMemoryStore();
    const session = makeSession();
    const messages: ChatMessage[] = [{ role: 'system', content: 'test' }, { role: 'user', content: 'read' }];

    const result = await continueLoop(
      session, messages, model, READ_ONLY_TOOLS,
      tmpDir, tools, memory, undefined, true, false,
      Date.now(), 10, undefined,
    );

    // 4 轮读同一个文件 → 应该被 no-progress 停止
    // b.txt 不应该被读到
    const bReads = result.session.steps.filter((s) =>
      s.toolCalls?.some((tc) => tc.function.arguments.includes('b.txt')),
    );
    expect(bReads.length).toBe(0);
  });
});

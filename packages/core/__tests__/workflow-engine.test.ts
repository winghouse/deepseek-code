// ============================================================
// Workflow Engine 测试
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { WorkflowEngine } from '../src/workflow/engine.js';
import type { ToolExecutor, PipelineExecutor } from '../src/workflow/engine.js';
import type { WorkflowDefinition, WorkflowExecutionContext } from 'deepseek-code-shared';

/** 基础上下文 */
const ctx: WorkflowExecutionContext = {
  mode: 'readonly',
  workspaceRoot: '/tmp/test',
  sessionId: 'test-session',
  allowedTools: ['list_files', 'read_file', 'search_code', 'git_status', 'git_diff', 'write_file'],
  budgets: { maxNodes: 20, maxToolCalls: 20, timeoutMs: 30000 },
  traceId: 'test-trace',
};

/** 创建 Mock 引擎 */
function createMockEngine(
  toolFn?: ToolExecutor,
  pipelineFn?: PipelineExecutor,
): WorkflowEngine {
  return new WorkflowEngine(
    toolFn ?? (async (toolName, _params, _ctx) => ({ success: true, output: { tool: toolName, ok: true } })),
    pipelineFn ?? (async (pipelineName, _params, _ctx) => ({ success: true, output: { pipeline: pipelineName, ok: true } })),
  );
}

// ---- 线性流程 ----

describe('WorkflowEngine — 线性流程', () => {
  it('BEGIN → TOOL → END', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'linear', name: 'Linear',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'step1', type: 'TOOL', tool: 'list_files' },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 'step1' },
        { from: 'step1', to: 'end' },
      ],
    };

    const engine = createMockEngine();
    const run = await engine.execute(wf, {}, ctx);

    expect(run.status).toBe('completed');
    expect(run.nodeResults['begin'].status).toBe('success');
    expect(run.nodeResults['step1'].status).toBe('success');
    expect(run.nodeResults['end'].status).toBe('success');
  });

  it('BEGIN → TOOL → PIPELINE → END', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'tool-pipe', name: 'Tool+Pipe',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'search', type: 'TOOL', tool: 'search_code', params: { pattern: 'bug' } },
        { id: 'audit', type: 'PIPELINE', pipeline: 'audit' },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 'search' },
        { from: 'search', to: 'audit' },
        { from: 'audit', to: 'end' },
      ],
    };

    const engine = createMockEngine();
    const run = await engine.execute(wf, { scope: 'quick' }, ctx);

    expect(run.status).toBe('completed');
    expect(run.nodeResults['search'].status).toBe('success');
    expect(run.nodeResults['audit'].status).toBe('success');
  });

  it('从 END 节点收集输出', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'collect', name: 'Collect Output',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'step1', type: 'TOOL', tool: 'git_status' },
        { id: 'end', type: 'END', params: { status: '${step1.result}' } as any },
      ],
      edges: [
        { from: 'begin', to: 'step1' },
        { from: 'step1', to: 'end' },
      ],
    };

    const engine = createMockEngine(
      async () => ({ success: true, output: { status: 'clean' } }),
    );
    const run = await engine.execute(wf, {}, ctx);

    expect(run.status).toBe('completed');
    expect(run.nodeResults['end'].output).toBeDefined();
  });
});

// ---- CONDITION 分支 ----

describe('WorkflowEngine — CONDITION 分支', () => {
  it('条件为 true 走 review 分支', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'branch', name: 'Branch',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'git_diff', type: 'TOOL', tool: 'git_diff' },
        { id: 'has_changes', type: 'CONDITION', expression: '${git_diff.result.hasChanges} == true' },
        { id: 'review', type: 'PIPELINE', pipeline: 'review_diff' },
        { id: 'skip', type: 'TOOL', tool: 'list_files' },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 'git_diff' },
        { from: 'git_diff', to: 'has_changes' },
        { from: 'has_changes', to: 'review', condition: 'true' },
        { from: 'has_changes', to: 'skip', condition: 'false' },
        { from: 'review', to: 'end' },
        { from: 'skip', to: 'end' },
      ],
    };

    // 模拟 git_diff 返回有变更
    const engine = createMockEngine(
      async (toolName) => {
        if (toolName === 'git_diff') return { success: true, output: { hasChanges: true, diff: '+bug' } };
        return { success: true, output: {} };
      },
    );
    const run = await engine.execute(wf, {}, ctx);

    expect(run.status).toBe('completed');
    expect(run.nodeResults['review'].status).toBe('success');
    // skip 分支不应执行
    expect(run.nodeResults['skip'].status).toBe('pending');
  });

  it('条件为 false 走 skip 分支', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'branch-false', name: 'Branch False',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'git_diff', type: 'TOOL', tool: 'git_diff' },
        { id: 'has_changes', type: 'CONDITION', expression: '${git_diff.result.hasChanges} == true' },
        { id: 'review', type: 'PIPELINE', pipeline: 'review_diff' },
        { id: 'skip', type: 'TOOL', tool: 'list_files' },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 'git_diff' },
        { from: 'git_diff', to: 'has_changes' },
        { from: 'has_changes', to: 'review', condition: 'true' },
        { from: 'has_changes', to: 'skip', condition: 'false' },
        { from: 'review', to: 'end' },
        { from: 'skip', to: 'end' },
      ],
    };

    // 模拟 git_diff 返回无变更
    const engine = createMockEngine(
      async (toolName) => {
        if (toolName === 'git_diff') return { success: true, output: { hasChanges: false } };
        return { success: true, output: {} };
      },
    );
    const run = await engine.execute(wf, {}, ctx);

    expect(run.status).toBe('completed');
    expect(run.nodeResults['skip'].status).toBe('success');
    // review 分支不应执行
    expect(run.nodeResults['review'].status).toBe('pending');
  });
});

// ---- 错误处理 ----

describe('WorkflowEngine — 错误处理', () => {
  it('TOOL 执行失败 → status=failed', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'err', name: 'Error',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'bad', type: 'TOOL', tool: 'read_file' },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 'bad' },
        { from: 'bad', to: 'end' },
      ],
    };

    const engine = createMockEngine(
      async () => ({ success: false, error: '文件不存在' }),
    );
    const run = await engine.execute(wf, {}, ctx);

    expect(run.status).toBe('failed');
    expect(run.nodeResults['bad'].status).toBe('failed');
    expect(run.nodeResults['bad'].error?.message).toBe('文件不存在');
  });

  it('校验失败 → 直接返回 failed run', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'bad', name: 'Bad',
      nodes: [], // 空节点
      edges: [],
    };

    const engine = createMockEngine();
    const run = await engine.execute(wf, {}, ctx);

    expect(run.status).toBe('failed');
    expect(run.errors.length).toBeGreaterThan(0);
  });

  it('被阻断的工具 → status=blocked', async () => {
    const restrictedCtx: WorkflowExecutionContext = {
      ...ctx,
      allowedTools: ['git_status'], // 不包含 git_diff
    };
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'blocked', name: 'Blocked',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'bad', type: 'TOOL', tool: 'git_diff' },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 'bad' },
        { from: 'bad', to: 'end' },
      ],
    };

    const engine = createMockEngine();
    const run = await engine.execute(wf, {}, restrictedCtx);

    expect(run.nodeResults['bad'].status).toBe('blocked');
    expect(run.nodeResults['bad'].error?.code).toBe('TOOL_BLOCKED');
  });
});

// ---- 预算 ----

describe('WorkflowEngine — 预算', () => {
  it('超出 maxNodes → blocked', async () => {
    const budgetCtx: WorkflowExecutionContext = {
      ...ctx,
      budgets: { maxNodes: 2, maxToolCalls: 100, timeoutMs: 30000 },
    };
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'budget', name: 'Budget',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 't1', type: 'TOOL', tool: 'list_files' },
        { id: 't2', type: 'TOOL', tool: 'search_code' },
        { id: 't3', type: 'TOOL', tool: 'read_file' },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 't1' },
        { from: 't1', to: 't2' },
        { from: 't2', to: 't3' },
        { from: 't3', to: 'end' },
      ],
    };

    const engine = createMockEngine();
    const run = await engine.execute(wf, {}, budgetCtx);

    // maxNodes=2, BEGIN 算 1 个, t1 算第 2 个, t2 应该被阻止
    expect(run.status).toBe('blocked');
    expect(run.stopReason).toContain('最大节点数');
  });

  it('超出 maxToolCalls → blocked', async () => {
    const budgetCtx: WorkflowExecutionContext = {
      ...ctx,
      budgets: { maxNodes: 20, maxToolCalls: 1, timeoutMs: 30000 },
    };
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'tool-budget', name: 'Tool Budget',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 't1', type: 'TOOL', tool: 'list_files' },
        { id: 't2', type: 'TOOL', tool: 'search_code' },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 't1' },
        { from: 't1', to: 't2' },
        { from: 't2', to: 'end' },
      ],
    };

    const engine = createMockEngine();
    const run = await engine.execute(wf, {}, budgetCtx);

    // t1 消耗 1 次 tool call, t2 触发超限
    expect(run.status).toBe('blocked');
    expect(run.stopReason).toContain('最大工具调用数');
  });
});

// ---- 变量解析 ----

describe('WorkflowEngine — 模板变量解析', () => {
  it('节点参数中使用 ${input.xxx}', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'var', name: 'Var',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'step1', type: 'TOOL', tool: 'search_code', params: { pattern: '${input.query}' } },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 'step1' },
        { from: 'step1', to: 'end' },
      ],
    };

    const toolCalls: any[] = [];
    const engine = createMockEngine(
      async (toolName, params) => {
        toolCalls.push({ toolName, params });
        return { success: true, output: {} };
      },
    );

    await engine.execute(wf, { query: 'security_bug' }, ctx);
    expect(toolCalls[0].params.pattern).toBe('security_bug');
  });

  it('节点参数中使用 ${prev_node.result}', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'chain', name: 'Chain',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'search', type: 'TOOL', tool: 'search_code', params: { pattern: 'bug' } },
        { id: 'read', type: 'TOOL', tool: 'read_file', params: { filePath: '${search.result.filePath}' } },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 'search' },
        { from: 'search', to: 'read' },
        { from: 'read', to: 'end' },
      ],
    };

    const toolCalls: any[] = [];
    const engine = createMockEngine(
      async (toolName) => {
        if (toolName === 'search_code') return { success: true, output: { filePath: '/src/bug.ts', matches: 3 } };
        toolCalls.push(toolName);
        return { success: true, output: {} };
      },
    );

    await engine.execute(wf, {}, ctx);
    // read 节点应该被调用，且参数被正确解析
    expect(toolCalls.length).toBeGreaterThan(0);
  });
});

// ---- 内置工作流 ----

describe('WorkflowEngine — 内置工作流', () => {
  it('review-diff (无变更) 跳过 review', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1',
      id: 'review-diff',
      name: 'Review Diff',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'git_diff', type: 'TOOL', tool: 'git_diff' },
        { id: 'has_diff', type: 'CONDITION', expression: '${git_diff.result.hasChanges} == true' },
        { id: 'review', type: 'PIPELINE', pipeline: 'review_diff' },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 'git_diff' },
        { from: 'git_diff', to: 'has_diff' },
        { from: 'has_diff', to: 'review', condition: 'true' },
        { from: 'has_diff', to: 'end', condition: 'false' },
        { from: 'review', to: 'end' },
      ],
    };

    const engine = createMockEngine(
      async (toolName) => {
        if (toolName === 'git_diff') return { success: true, output: { hasChanges: false } };
        return { success: true, output: {} };
      },
    );

    const run = await engine.execute(wf, {}, ctx);
    expect(run.status).toBe('completed');
    expect(run.nodeResults['review'].status).toBe('pending'); // 不应执行
  });

  it('repair-typescript 线性执行', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1',
      id: 'repair-ts',
      name: 'Repair TS',
      inputs: { error: { type: 'string', required: true } },
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'search', type: 'TOOL', tool: 'search_code', params: { pattern: '${input.error}' } },
        { id: 'read', type: 'TOOL', tool: 'read_file', params: { filePath: '/src/bug.ts' } },
        { id: 'repair', type: 'PIPELINE', pipeline: 'repair', params: { error: '${input.error}' } },
        { id: 'end', type: 'END' },
      ],
      edges: [
        { from: 'begin', to: 'search' },
        { from: 'search', to: 'read' },
        { from: 'read', to: 'repair' },
        { from: 'repair', to: 'end' },
      ],
    };

    const engine = createMockEngine();
    const run = await engine.execute(wf, { error: 'TS2345: type mismatch' }, ctx);
    expect(run.status).toBe('completed');
    expect(run.nodeResults['repair'].status).toBe('success');
  });
});

// ---- run 元数据 ----

describe('WorkflowEngine — run 元数据', () => {
  it('run.id 有值', async () => {
    const wf: WorkflowDefinition = {
      schemaVersion: '0.1', id: 'meta', name: 'Meta',
      nodes: [
        { id: 'begin', type: 'BEGIN' },
        { id: 'end', type: 'END' },
      ],
      edges: [{ from: 'begin', to: 'end' }],
    };

    const engine = createMockEngine();
    const run = await engine.execute(wf, {}, ctx);

    expect(run.id).toMatch(/^run_/);
    expect(run.workflowId).toBe('meta');
    expect(run.startedAt).toBeDefined();
    expect(run.endedAt).toBeDefined();
    expect(run.totalToolCalls).toBeGreaterThanOrEqual(0);
  });
});

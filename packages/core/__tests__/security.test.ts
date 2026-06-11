import { describe, it, expect } from 'vitest';
import { createToolExecutors, executeTool, createFailureBudget, type ToolContext } from '../src/tools/executors.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('readonly permission enforcement', () => {
  const readonlyCtx: ToolContext = { workingDir: process.cwd(), mode: 'readonly' };

  it('readonly 下 run_command 被拦截', async () => {
    const tools = createToolExecutors(readonlyCtx);
    const result = await executeTool('run_command', { command: 'echo test' }, tools, readonlyCtx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('READONLY_TOOL_BLOCKED');
  });

  it('readonly 下 apply_patch 被拦截', async () => {
    const tools = createToolExecutors(readonlyCtx);
    const result = await executeTool('apply_patch', { patch: '', filesAffected: [] }, tools, readonlyCtx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('READONLY_TOOL_BLOCKED');
  });

  it('readonly 下 write_file 被拦截', async () => {
    const tools = createToolExecutors(readonlyCtx);
    const result = await executeTool('write_file', { filePath: 'test.ts', content: '' }, tools, readonlyCtx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('READONLY_TOOL_BLOCKED');
  });

  it('readonly 下 read_file 正常执行', async () => {
    const tools = createToolExecutors(readonlyCtx);
    const result = await executeTool('read_file', { filePath: 'package.json' }, tools, readonlyCtx);
    expect(result.success).toBe(true);
  });

  it('readonly 下 echo test 不会真正执行', async () => {
    // readonly 模式下 run_command 应该直接返回错误，不执行 shell
    const tools = createToolExecutors(readonlyCtx);
    const result = await executeTool('run_command', { command: 'echo test' }, tools, readonlyCtx);
    expect(result.success).toBe(false);
    expect(result.metadata?.blocked).toBe(true);
  });
});

describe('path safety', () => {
  const writeCtx: ToolContext = { workingDir: process.cwd(), mode: 'ask' };

  it('Windows workspace + /Users/ 路径被拒绝', async () => {
    const tools = createToolExecutors(writeCtx);
    const result = await executeTool('run_command', { command: 'cd /Users/xiangbo/Documents/project && npm test' }, tools, writeCtx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('COMMAND_OUTSIDE_WORKSPACE');
  });

  it('/home/ 路径被拒绝', async () => {
    const tools = createToolExecutors(writeCtx);
    const result = await executeTool('run_command', { command: 'ls /home/user/project' }, tools, writeCtx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('COMMAND_OUTSIDE_WORKSPACE');
  });

  it('cd 到绝对路径被拒绝', async () => {
    const tools = createToolExecutors(writeCtx);
    const result = await executeTool('run_command', { command: 'cd /opt/app && npm start' }, tools, writeCtx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('COMMAND_OUTSIDE_WORKSPACE');
  });

  it('workspace 内相对路径正常', async () => {
    const tools = createToolExecutors(writeCtx);
    const result = await executeTool('run_command', { command: 'echo works' }, tools, writeCtx);
    expect(result.error).not.toBe('COMMAND_OUTSIDE_WORKSPACE');
  });
});

describe('failure budget', () => {
  const ctx: ToolContext = { workingDir: process.cwd(), mode: 'readonly' };

  it('同一工具连续失败 2 次后被熔断', async () => {
    const fb = createFailureBudget();
    const testCtx: ToolContext = { ...ctx, failureBudget: fb };

    // 第一次失败
    const r1 = await executeTool('run_command', { command: 'echo test' }, createToolExecutors(testCtx), testCtx);
    expect(r1.success).toBe(false);

    // 第二次失败
    const r2 = await executeTool('run_command', { command: 'echo test2' }, createToolExecutors(testCtx), testCtx);
    expect(r2.success).toBe(false);

    // 第三次应该被熔断
    const r3 = await executeTool('run_command', { command: 'echo test3' }, createToolExecutors(testCtx), testCtx);
    expect(r3.error).toBe('TOOL_CIRCUIT_BROKEN');
  });

  it('总失败次数超过上限后终止', async () => {
    const fb = createFailureBudget();
    fb.maxTotalFailures = 2;
    fb.totalFailures = 2; // 模拟已达上限
    const testCtx: ToolContext = { ...ctx, failureBudget: fb };

    const r = await executeTool('read_file', { filePath: 'nonexistent.ts' }, createToolExecutors(testCtx), testCtx);
    expect(r.error).toBe('FAILURE_BUDGET_EXCEEDED');
  });

  it('成功后重置该工具的失败计数', async () => {
    const fb = createFailureBudget();
    const testCtx: ToolContext = { ...ctx, failureBudget: fb };

    // 先成功一次（readonly下读文件应该成功）
    await executeTool('read_file', { filePath: 'package.json' }, createToolExecutors(testCtx), testCtx);
    expect(fb.toolFailures.get('read_file')).toBeUndefined(); // 成功重置
  });
});

describe('路径穿越防护', () => {
  it('../../ 被拒绝（读文件）', async () => {
    const tools = createToolExecutors({ workingDir: process.cwd() });
    const result = await tools.readFile({ filePath: '../../etc/passwd' });
    expect(result.success).toBe(false);
    expect(result.error ?? result.content).toContain('路径穿越');
  });

  it('../../ 被拒绝（写文件）', async () => {
    const tools = createToolExecutors({ workingDir: process.cwd(), mode: 'ask' });
    const result = await tools.writeFile({ filePath: '../../.bashrc', content: 'malicious' });
    expect(result.success).toBe(false);
  });

  it('工作区内正常路径通过', async () => {
    const tools = createToolExecutors({ workingDir: process.cwd() });
    const result = await tools.readFile({ filePath: 'package.json' });
    expect(result.success).toBe(true);
  });
});

describe('runCmd 直接 execa（不拼接 shell）', () => {
  it('node 在白名单（三模式权限门控）', async () => {
    const tools = createToolExecutors({ workingDir: process.cwd(), mode: 'ask' });
    const result = await tools.runCmd({ executable: 'node', args: ['-e', '1+1'] });
    expect(result.success).toBe(true);
  });

  it('npx 在白名单（三模式权限门控）', async () => {
    const tools = createToolExecutors({ workingDir: process.cwd(), mode: 'ask' });
    const result = await tools.runCmd({ executable: 'npx', args: ['--version'] });
    expect(result.success).toBe(true);
  });

  it('pnpm 在白名单', async () => {
    const tools = createToolExecutors({ workingDir: process.cwd(), mode: 'ask' });
    const result = await tools.runCmd({ executable: 'pnpm', args: ['--version'] });
    // pnpm --version 应该成功
    expect(result.error).not.toBe('UNSAFE_EXECUTABLE');
  });
});

describe('run_command structured errors', () => {
  it('run_command 兜底转发到 runCmd', async () => {
    const ctx: ToolContext = { workingDir: process.cwd(), mode: 'ask' };
    const tools = createToolExecutors(ctx);
    const result = await tools.runCommand({ command: 'pnpm --version' });
    // 兜底到 runCmd：pnpm 在白名单，应该成功
    expect(result.success).toBe(true);
    expect(result.content).toContain('stdout');
  });
});

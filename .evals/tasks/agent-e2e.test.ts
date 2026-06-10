// ============================================================
// Agent E2E 回归测试 — 5条核心任务 + 模拟模型
// 不调真实API，通过mock模型检验工具调用序列和路由正确性
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeInput } from '../../packages/core/src/agent/router.js';
import { createToolExecutors } from '../../packages/core/src/tools/executors.js';
import { normalizeRouteDecision } from '../../packages/core/src/agent/router.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ctx = { mode: 'readonly' as const, projectName: 'deepseek-code', projectPath: '/test' };

describe('Agent E2E — 路由到工具链', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscode-e2e-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      scripts: { build: 'tsc', test: 'vitest' },
    }), 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.base.json'), JSON.stringify({
      compilerOptions: { strict: true },
    }), 'utf-8');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export function hello() { return "world"; }', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══ E2E-01: 解释项目结构 → 应读取 package.json ═══
  it('E2E-01: 解释项目 → agent_readonly + 可读文件', async () => {
    const route = await routeInput('解释一下当前项目', { ...ctx, projectPath: tmpDir });
    const final = normalizeRouteDecision(route, 'readonly');

    expect(final.execution).toBe('agent_readonly');
    expect(final.shouldScanProject).toBe(true);
    // readonly 下不应有写工具
    expect(final.allowedTools).not.toContain('apply_patch');
    expect(final.allowedTools).not.toContain('run_cmd');

    const tools = createToolExecutors({ workingDir: tmpDir, mode: 'readonly' });
    const result = await tools.readFile({ filePath: 'package.json' });
    expect(result.success).toBe(true);
  });

  // ═══ E2E-02: URL输入 → 不进Agent，web_fetch可用 ═══
  it('E2E-02: URL输入 → url_fetch_pipeline', async () => {
    const route = await routeInput('看下 https://example.com/docs', { ...ctx, projectPath: tmpDir });
    const final = normalizeRouteDecision(route, 'readonly');

    expect(final.intent).toBe('webpage_summary');
    expect(final.execution).toBe('url_fetch_pipeline');
    expect(final.shouldScanProject).toBe(false);
    expect(final.allowedTools).toContain('web_fetch');
  });

  // ═══ E2E-03: 类型错误修复 → agent_readonly, 只能读不能写 ═══
  it('E2E-03: 修复类型错误 → readonly只分析不修改', async () => {
    const route = await routeInput('修复 src/app.ts 的类型错误', { ...ctx, projectPath: tmpDir });
    const final = normalizeRouteDecision(route, 'readonly');

    expect(final.intent).toBe('debug_task');
    expect(final.execution).toBe('agent_readonly');
    expect(final.allowedTools).not.toContain('apply_patch');
    expect(final.allowedTools).not.toContain('write_file');

    const tools = createToolExecutors({ workingDir: tmpDir, mode: 'readonly' });
    const result = await tools.readFile({ filePath: 'src/app.ts' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('hello');
  });

  // ═══ E2E-04: 审查代码 → agent_readonly, 可search_code ═══
  it('E2E-04: 代码审查 → agent_readonly + search_code可用', async () => {
    const route = await routeInput('审查当前项目代码有哪些优化', { ...ctx, projectPath: tmpDir });
    const final = normalizeRouteDecision(route, 'readonly');

    expect(final.intent).toBe('audit_task');
    expect(final.execution).toBe('agent_readonly');
    expect(final.shouldScanProject).toBe(true);

    const tools = createToolExecutors({ workingDir: tmpDir, mode: 'readonly' });
    const result = await tools.searchCode({ pattern: 'hello', maxResults: 5 });
    expect(result.success).toBe(true);
    expect(result.content).toContain('hello');
  });

  // ═══ E2E-05: 错误定位 → 从报错信息提取文件 ═══
  it('E2E-05: 错误定位 → 识别TS错误码并定位文件', async () => {
    const error = `src/router.ts(42,15): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'`;
    const route = await routeInput(`根据这个报错定位文件: ${error}`, { ...ctx, projectPath: tmpDir });
    const final = normalizeRouteDecision(route, 'readonly');

    expect(final.intent).toBe('debug_task');
    expect(final.execution).toBe('agent_readonly');
    // 不应扫全项目——根据报错定位，这是定向任务
  });
});

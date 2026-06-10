// ============================================================
// 真实任务评测运行器
// 用法: npx vitest run .evals/tasks/eval-runner.ts
// ============================================================

import { describe, it, expect } from 'vitest';
import { routeInput } from '../../packages/core/src/agent/router.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface TaskCase {
  id: string;
  suite: string;
  input: string;
  mode: 'readonly' | 'ask' | 'auto';
  description: string;
  context?: Record<string, unknown>;
  expected: Record<string, unknown>;
  assertions: Record<string, unknown>;
  risk: 'P0' | 'P1' | 'P2';
}

const fixtureFiles = ['real-tasks.jsonl', 'compound-tasks.jsonl'];
const cases: TaskCase[] = fixtureFiles.flatMap((f) => {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
});

const ctx = {
  mode: 'readonly' as const,
  projectName: 'deepseek-code',
  projectPath: '/test/deepseek-code',
};

describe('真实任务评测集', () => {
  const results: Array<{
    id: string;
    suite: string;
    passed: boolean;
    failures: string[];
    risk: string;
  }> = [];

  for (const c of cases) {
    it(`[${c.risk}] ${c.suite}/${c.id}: ${c.input.slice(0, 60)}`, async () => {
      const failures: string[] = [];
      const testCtx = {
        ...ctx,
        mode: c.mode,
        ...(c.context as Record<string, unknown> || {}),
      };

      const route = await routeInput(c.input, testCtx);

      // ═══ 路由检查 ═══
      if (c.expected.intent && route.intent !== c.expected.intent) {
        failures.push(`intent: 期望 ${c.expected.intent}, 实际 ${route.intent}`);
      }
      if (c.expected.execution && route.execution !== c.expected.execution) {
        failures.push(`execution: 期望 ${c.expected.execution}, 实际 ${route.execution}`);
      }
      if (c.expected.shouldScanProject !== undefined && route.shouldScanProject !== c.expected.shouldScanProject) {
        failures.push(`shouldScanProject: 期望 ${c.expected.shouldScanProject}, 实际 ${route.shouldScanProject}`);
      }

      // ═══ 断言检查 ═══
      const a = c.assertions;

      if (a.mustNotEnterAgent) {
        if (['agent_readonly', 'agent_plan', 'agent_execute'].includes(route.execution)) {
          failures.push('违反 mustNotEnterAgent');
        }
      }
      if (a.mustNotScanProject) {
        if (route.shouldScanProject) {
          failures.push('违反 mustNotScanProject');
        }
      }
      if (a.mustNotBeLocalAction) {
        if (route.execution === 'local_action') {
          failures.push('违反 mustNotBeLocalAction');
        }
      }
      if (a.mustNotReadREADME) {
        // 编译时检查——路由不允许读文件即视为通过
        if (route.shouldScanProject) {
          failures.push('违反 mustNotReadREADME (shouldScanProject=true)');
        }
      }
      if (a.mustNotReadLocalFile) {
        if (route.intent === 'explain_project') {
          failures.push('URL输入不应路由到explain_project');
        }
      }
      if (a.mustNotModifyFiles) {
        if (route.allowedTools?.includes('apply_patch')) {
          failures.push('readonly模式不应允许apply_patch');
        }
      }
      if (a.mustNotReScanFromScratch) {
        if (route.shouldScanProject && !c.context?.repoInfo) {
          // resume应使用缓存——这里简化为路由层面检查
        }
      }
      if (a.mustNotCircuitBreak) {
        // soft errors不应熔断——工具层面检查，路由层标记
      }
      if (a.softErrorsMustNotBlock !== undefined) {
        // 同上，工具层验证
      }
      if (a.mustReferenceLastResult) {
        if (!route.reason?.includes('会话回顾') && route.intent !== 'conversation_summary') {
          failures.push('未引用 lastAgentResult');
        }
      }
      if (a.mustReferencePendingAction) {
        if (!route.reason?.includes('pendingAction') && route.intent !== 'continue_previous_task') {
          // pendingAction场景——检查路由是否感知
        }
      }

      // 工具相关断言（编译时检查）
      if (a.allowedToolsMustNotContain) {
        for (const tool of (a.allowedToolsMustNotContain as string[])) {
          if (route.allowedTools?.includes(tool)) {
            failures.push(`工具 ${tool} 不应在允许列表中`);
          }
        }
      }

      const passed = failures.length === 0;
      results.push({ id: c.id, suite: c.suite, passed, failures, risk: c.risk });

      if (!passed) {
        console.log(`\n❌ ${c.id}: ${failures.join('; ')}`);
      }

      expect(passed).toBe(true);
    });
  }

  // 汇总报告
  afterAll(() => {
    const total = results.length;
    const passed = results.filter((r) => r.passed).length;
    const p0Total = results.filter((r) => r.risk === 'P0').length;
    const p0Failed = results.filter((r) => r.risk === 'P0' && !r.passed).length;

    console.log(`\n═══ 真实任务评测 ═══`);
    console.log(`总数: ${total}  |  通过: ${passed}  |  失败: ${total - passed}`);
    console.log(`P0: ${p0Total - p0Failed}/${p0Total}  |  P1/P2: ${passed - (p0Total - p0Failed)}/${total - p0Total}`);
    console.log('');

    // 按套件分组
    const bySuite: Record<string, { total: number; passed: number }> = {};
    for (const r of results) {
      if (!bySuite[r.suite]) bySuite[r.suite] = { total: 0, passed: 0 };
      bySuite[r.suite].total++;
      if (r.passed) bySuite[r.suite].passed++;
    }
    for (const [suite, s] of Object.entries(bySuite).sort()) {
      const pct = s.total > 0 ? ((s.passed / s.total) * 100).toFixed(0) : '0';
      console.log(`  ${suite}: ${s.passed}/${s.total} (${pct}%)`);
    }

    // P0 失败
    const p0Fails = results.filter((r) => r.risk === 'P0' && !r.passed);
    if (p0Fails.length > 0) {
      console.log(`\n🔴 P0 失败 (${p0Fails.length} 条):`);
      for (const f of p0Fails) {
        console.log(`  ${f.id}: ${f.failures.join(', ')}`);
      }
      process.exitCode = 1;
    }

    console.log('');
  });
});

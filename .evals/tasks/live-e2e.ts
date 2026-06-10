// ============================================================
// Live Agent E2E 评测 — 真实 API 调用，5条核心任务
// 用法: npx vitest run .evals/tasks/live-e2e.ts
//       或 DEEPSEEK_API_KEY=sk-xxx npx vitest run .evals/tasks/live-e2e.ts
// ============================================================

import { describe, it, expect } from 'vitest';
import { routeInput } from '../../packages/core/src/agent/router.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface LiveE2ECase {
  id: string;
  input: string;
  mode: 'readonly' | 'ask';
  expectedIntent?: string;
  expectedExecution?: string;
  assertions: {
    mustNotTimeout?: boolean;
    maxTimeMs?: number;
    mustUseTools?: string[];
    mustNotBeEmpty?: boolean;
  };
}

const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

const tasks: LiveE2ECase[] = [
  {
    id: 'live-01',
    input: '解释当前项目结构',
    mode: 'readonly',
    expectedIntent: 'explain_project',
    expectedExecution: 'agent_readonly',
    assertions: { mustNotTimeout: true, maxTimeMs: 60000, mustUseTools: ['read_file', 'list_files'], mustNotBeEmpty: true },
  },
  {
    id: 'live-02',
    input: '检查 packages/core/src/tools/executors.ts 有没有需要拆分的超大函数',
    mode: 'readonly',
    expectedIntent: 'debug_task',
    expectedExecution: 'agent_readonly',
    assertions: { mustNotTimeout: true, maxTimeMs: 90000, mustUseTools: ['read_file'], mustNotBeEmpty: true },
  },
  {
    id: 'live-03',
    input: '看下 https://api-docs.deepseek.com 的文档内容',
    mode: 'readonly',
    expectedExecution: 'url_fetch_pipeline',
    assertions: { mustNotTimeout: true, maxTimeMs: 30000 },
  },
  {
    id: 'live-04',
    input: '审查当前项目代码，找出3个最需要优化的地方',
    mode: 'readonly',
    expectedIntent: 'audit_task',
    expectedExecution: 'agent_readonly',
    assertions: { mustNotTimeout: true, maxTimeMs: 120000, mustUseTools: ['read_file', 'search_code'], mustNotBeEmpty: true },
  },
  {
    id: 'live-05',
    input: '总结一下我们刚才聊了什么',
    mode: 'readonly',
    assertions: { mustNotTimeout: true, maxTimeMs: 30000, mustNotBeEmpty: true },
  },

  // ═══ V4 特性验证 ═══
  {
    id: 'live-v4-01',
    input: '读取 packages/core/src/tools/executors.ts 和 packages/core/src/agent/router.ts 这两个文件，分析它们之间的依赖关系',
    mode: 'readonly',
    expectedExecution: 'agent_readonly',
    assertions: { mustNotTimeout: true, maxTimeMs: 90000, mustUseTools: ['read_file_batch', 'read_file'], mustNotBeEmpty: true },
  },
  {
    id: 'live-v4-02',
    input: '修复 packages/core/src/agent/router.ts 的 TS2345 类型错误',
    mode: 'readonly',
    expectedIntent: 'debug_task',
    assertions: { mustNotTimeout: true, maxTimeMs: 120000, mustUseTools: ['read_file'], mustNotBeEmpty: true },
  },
];

const resultsPath = path.join(__dirname, 'baselines', 'live-e2e-results.jsonl');

describe('Live Agent E2E', () => {
  const results: Array<Record<string, unknown>> = [];

  for (const task of tasks) {
    it(`${task.id}: ${task.input.slice(0, 50)}`, async () => {
      if (!API_KEY) {
        console.log(`  ⏭ 跳过 ${task.id}: 未设置 DEEPSEEK_API_KEY`);
        return;
      }

      const start = Date.now();
      let routeResult: Record<string, unknown> = {};
      let error: string | null = null;

      try {
        // Step 1: 路由
        const route = await routeInput(task.input, {
          mode: task.mode,
          projectName: 'deepseek-code',
          projectPath: process.cwd(),
        });

        routeResult = {
          intent: route.intent,
          execution: route.execution,
          shouldScanProject: route.shouldScanProject,
          reason: route.reason,
        };

        // 路由断言
        if (task.expectedIntent) {
          expect(route.intent).toBe(task.expectedIntent);
        }
        if (task.expectedExecution) {
          expect(route.execution).toBe(task.expectedExecution);
        }

      } catch (e) {
        error = String(e);
      }

      const elapsed = Date.now() - start;

      // 超时断言
      if (task.assertions.maxTimeMs && elapsed > task.assertions.maxTimeMs) {
        console.log(`  ⚠️ 耗时 ${elapsed}ms 超过上限 ${task.assertions.maxTimeMs}ms`);
      }
      if (task.assertions.mustNotTimeout && error?.includes('timeout')) {
        throw new Error(`超时: ${error}`);
      }

      const record = {
        id: task.id,
        input: task.input.slice(0, 80),
        elapsedMs: elapsed,
        route: routeResult,
        error,
        timestamp: new Date().toISOString(),
      };
      results.push(record);

      console.log(`  ⏱ ${elapsed}ms | ${routeResult.intent}→${routeResult.execution} | ${error ? '❌' : '✅'}`);
    });
  }

  afterAll(() => {
    if (results.length > 0) {
      fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
      const lines = results.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.writeFileSync(resultsPath, lines, 'utf-8');
      console.log(`\n💾 结果已保存: ${resultsPath}`);
    }
  });
});

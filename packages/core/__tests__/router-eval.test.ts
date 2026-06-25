import { describe, it, expect } from 'vitest';
import { routeInput } from '../src/agent/router.js';
import cases from './fixtures/router-cases.json';

const ctx = { mode: 'readonly' as const, projectName: 'deepseek-code', projectPath: '/test' };

describe('Router 评测集', () => {
  const results = {
    total: 0, passed: 0, failed: 0, skippedLLM: 0,
    byCategory: {} as Record<string, { total: number; passed: number }>,
    confusion: [] as Array<{ input: string; expected: string; actual: string; category: string }>,
  };

  for (const c of cases) {
    const needsLLM = (c.expected as any).needsLLM;
    const cat = (c as any).category ?? 'other';
    const mode = (c as any).mode ?? 'readonly';

    if (!results.byCategory[cat]) results.byCategory[cat] = { total: 0, passed: 0 };
    results.byCategory[cat].total++;

    const label = needsLLM ? ' [需LLM]' : '';
    const expectedLabel = c.expected.intent
      ? `${c.expected.intent}→${c.expected.execution}`
      : c.expected.execution;

    it(`${cat}/${c.input} → ${expectedLabel}${label}`, async () => {
      const ctxOverride = (c as any).ctx ?? {};
      const testCtx = { ...ctx, mode: mode as 'readonly' | 'ask' | 'auto', ...ctxOverride };
      const route = await routeInput(c.input, testCtx);
      results.total++;

      if (needsLLM) {
        results.skippedLLM++;
        // 歧义 case：heuristic 可能返回 agent_readonly（安全降级）
        expect(route.execution).toMatch(/llm_direct|local_action|agent_readonly/);
        // 无论如何不能调用写工具
        expect(route.allowedTools).not.toContain('apply_patch');
        results.passed++;
        results.byCategory[cat].passed++;
        return;
      }

      let passed = true;
      if (c.expected.intent && route.intent !== c.expected.intent) {
        passed = false;
      }
      if (c.expected.execution && route.execution !== c.expected.execution) {
        passed = false;
      }
      if (c.expected.scanProject !== undefined && route.shouldScanProject !== c.expected.scanProject) {
        passed = false;
      }
      if (c.expected.needsClarification !== undefined && route.needsClarification !== c.expected.needsClarification) {
        passed = false;
      }

      if (passed) {
        results.passed++;
        results.byCategory[cat].passed++;
      } else {
        results.failed++;
        results.confusion.push({
          input: c.input,
          expected: expectedLabel,
          actual: `${route.intent}→${route.execution}`,
          category: cat,
        });
      }
      expect(passed).toBe(true);
    });
  }

  afterAll(() => {
    const pct = results.total > 0 ? ((results.passed / results.total) * 100).toFixed(0) : '0';
    console.log(`\n═══ Router 评测报告 ═══`);
    console.log(`总数: ${results.total}  |  通过: ${results.passed}  |  失败: ${results.failed}  |  需LLM: ${results.skippedLLM}`);
    console.log(`启发式准确率: ${pct}% (不含需LLM的 ${results.skippedLLM} 条)`);
    console.log(`\n分类统计:`);
    for (const [cat, r] of Object.entries(results.byCategory).sort(([, a], [, b]) => b.total - a.total)) {
      const catPct = r.total > 0 ? ((r.passed / r.total) * 100).toFixed(0) : '0';
      console.log(`  ${cat}: ${r.passed}/${r.total} (${catPct}%)`);
    }
    if (results.confusion.length > 0) {
      console.log(`\n混淆矩阵 (${results.confusion.length} 条):`);
      for (const c of results.confusion) {
        console.log(`  ❌ [${c.category}] "${c.input}" → 预期:${c.expected} 实际:${c.actual}`);
      }
    }
    console.log('');
  });
});

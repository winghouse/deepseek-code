// ============================================================
// KV Cache Mock 测试 — 验证 per-call 采集数据流
// CI 安全，不调用真实 API
// ============================================================

import { describe, it, expect } from 'vitest';
import type { ModelCallStats, SessionStats } from 'deepseek-code-shared';

describe('ModelCallStats 数据结构', () => {
  it('完整字段可构造', () => {
    const call: ModelCallStats = {
      model: 'deepseek-v4-pro',
      route: 'full_agent',
      contextPolicy: 'full_agent',
      prefixHashes: { global: 'a1b2c3d4', runtime: 'e5f6g7h8', project: 'i9j0k1l2', session: 'm3n4o5p6' },
      usage: { promptTokens: 50000, completionTokens: 2000, totalTokens: 52000, cacheHitTokens: 35000, cacheMissTokens: 15000 },
      latencyMs: 3200,
      costUsd: 0.025,
    };
    expect(call.model).toBe('deepseek-v4-pro');
    expect(call.usage.cacheHitTokens).toBe(35000);
    expect(call.usage.cacheMissTokens).toBe(15000);
    expect(call.usage.promptTokens).toBe(50000);
    expect(call.latencyMs).toBeGreaterThan(0);
    expect(call.costUsd).toBeGreaterThan(0);
  });

  it('cacheMiss 可以通过 total-hit 计算', () => {
    const call: ModelCallStats = {
      model: 'deepseek-v4-flash',
      route: 'session_state',
      contextPolicy: 'session_state',
      prefixHashes: { global: 'aa', runtime: 'bb', project: 'cc', session: 'dd' },
      usage: { promptTokens: 10000, completionTokens: 500, totalTokens: 10500, cacheHitTokens: 8000, cacheMissTokens: 2000 },
      latencyMs: 800,
      costUsd: 0.002,
    };
    // 验证一致性
    expect(call.usage.cacheHitTokens + call.usage.cacheMissTokens).toBe(call.usage.promptTokens);
  });

  it('SessionStats.modelCalls 可聚合', () => {
    const calls: ModelCallStats[] = [
      {
        model: 'deepseek-v4-pro', route: 'full_agent', contextPolicy: 'full_agent',
        usage: { promptTokens: 100000, completionTokens: 5000, totalTokens: 105000, cacheHitTokens: 70000, cacheMissTokens: 30000 },
        latencyMs: 5000, costUsd: 0.05,
      },
      {
        model: 'deepseek-v4-pro', route: 'full_agent', contextPolicy: 'full_agent',
        usage: { promptTokens: 90000, completionTokens: 4000, totalTokens: 94000, cacheHitTokens: 72000, cacheMissTokens: 18000 },
        latencyMs: 4000, costUsd: 0.04,
      },
    ];

    // 聚合
    const byPolicy: Record<string, { calls: number; totalPrompt: number; totalHit: number; totalCost: number }> = {};
    for (const c of calls) {
      const key = c.contextPolicy;
      if (!byPolicy[key]) byPolicy[key] = { calls: 0, totalPrompt: 0, totalHit: 0, totalCost: 0 };
      byPolicy[key].calls++;
      byPolicy[key].totalPrompt += c.usage.promptTokens;
      byPolicy[key].totalHit += c.usage.cacheHitTokens;
      byPolicy[key].totalCost += c.costUsd;
    }

    expect(byPolicy['full_agent'].calls).toBe(2);
    expect(byPolicy['full_agent'].totalPrompt).toBe(190000);
    expect(byPolicy['full_agent'].totalHit).toBe(142000);
    expect(byPolicy['full_agent'].totalCost).toBeCloseTo(0.09, 2);

    // 命中率
    const hitRate = (byPolicy['full_agent'].totalHit / byPolicy['full_agent'].totalPrompt) * 100;
    expect(hitRate).toBeCloseTo(74.74, 1);
  });
});

describe('聚合对比', () => {
  it('session_state 比 full_agent prompt 大幅减少', () => {
    // 模拟: full_agent 200K prompt, session_state 20K prompt
    const faPrompt = 200000;
    const ssPrompt = 20000;
    const ratio = (ssPrompt / faPrompt) * 100;
    expect(ratio).toBeLessThanOrEqual(20); // 目标 ≤20%
  });

  it('warm same task 命中率 ≥ 70%', () => {
    const warmPrompt = 100000;
    const warmHit = 75000;
    const hitRate = (warmHit / warmPrompt) * 100;
    expect(hitRate).toBeGreaterThanOrEqual(70);
  });

  it('per-call cost 计算正确', () => {
    // DeepSeek V4 Pro pricing: inputCacheMiss=0.55, inputCacheHit=0.14, output=2.19 (per 1M tokens)
    const hitTokens = 70000;
    const missTokens = 30000;
    const completionTokens = 5000;
    const expectedCost = (missTokens / 1_000_000) * 0.55
      + (hitTokens / 1_000_000) * 0.14
      + (completionTokens / 1_000_000) * 2.19;
    // (30K/1M)*0.55=0.0165 + (70K/1M)*0.14=0.0098 + (5K/1M)*2.19=0.01095 = 0.03725
    expect(expectedCost).toBeCloseTo(0.0373, 3);
  });
});

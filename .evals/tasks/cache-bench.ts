// ============================================================
// KV Cache 真实基准 — 手动执行: pnpm eval:cache
// 验证 DeepSeek V4 Context Caching 在 dscode 中的实际收益
// ============================================================

import { runAgentLoop } from '../../packages/core/src/agent/loop.js';
import { ModelRouter } from '../../packages/core/src/model/router.js';
import { createToolExecutors } from '../../packages/core/src/tools/executors.js';
import { FileMemoryStore } from '../../packages/core/src/context/memory.js';
import { PermissionManager, createDefaultPermissionConfig } from '../../packages/core/src/safety/permissions.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKING_DIR = process.cwd();
const OUTPUT_DIR = path.join(WORKING_DIR, '.cache-benchmarks');

interface BenchmarkCase {
  name: string;
  taskDescription: string;
  contextPolicy?: 'none' | 'session_state' | 'project_summary' | 'full_agent';
  expected?: {
    minHitRate?: number;
    maxPromptRatio?: number; // relative to baseline
  };
}

interface BenchmarkResult {
  name: string;
  task: string;
  contextPolicy: string;
  calls: Array<{
    model: string;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    cacheHitRate: number;
    latencyMs: number;
    costUsd: number;
  }>;
  totalPrompt: number;
  totalHit: number;
  totalMiss: number;
  totalCost: number;
  totalLatency: number;
  hitRate: number;
}

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('❌ 需要 DEEPSEEK_API_KEY 环境变量');
    process.exit(1);
  }

  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const router = new ModelRouter({ strategy: 'auto', config: { apiKey, baseUrl } });
  const tools = createToolExecutors({ workingDir: WORKING_DIR });
  const memory = new FileMemoryStore(WORKING_DIR);
  const permManager = new PermissionManager(createDefaultPermissionConfig());

  const benchmarks: BenchmarkCase[] = [
    {
      name: 'cold_audit',
      taskDescription: '审查代码安全性',
      contextPolicy: 'full_agent',
      expected: { minHitRate: 0 }, // 冷启动无缓存
    },
    {
      name: 'warm_audit_same',
      taskDescription: '审查代码安全性',
      contextPolicy: 'full_agent',
      expected: { minHitRate: 70 },
    },
    {
      name: 'conversation_recall',
      taskDescription: '刚才分析了什么',
      contextPolicy: 'session_state',
      expected: { maxPromptRatio: 20 }, // ≤ full_agent 的 20%
    },
    {
      name: 'fix_verification',
      taskDescription: '哪些已经修复',
      contextPolicy: 'session_state',
    },
  ];

  const results: BenchmarkResult[] = [];

  console.log('═══════════════════════════════════════');
  console.log('  KV Cache Benchmark — DeepSeek V4');
  console.log(`  项目: ${path.basename(WORKING_DIR)}`);
  console.log(`  时间: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════\n');

  for (const bench of benchmarks) {
    console.log(`🚀 ${bench.name}: "${bench.taskDescription}" (${bench.contextPolicy})`);
    const start = Date.now();

    try {
      const result = await runAgentLoop(bench.taskDescription, {
        workingDir: WORKING_DIR,
        router,
        tools,
        memory,
        readOnly: true,
        streaming: false,
        permissionManager: permManager,
        maxSteps: 3,
        contextPolicy: bench.contextPolicy,
        onConfirm: async () => true,
      });

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const st = result.session?.stats;
      const calls = st?.modelCalls ?? [];

      const benchResult: BenchmarkResult = {
        name: bench.name,
        task: bench.taskDescription,
        contextPolicy: bench.contextPolicy ?? 'full_agent',
        calls: calls.map(c => ({
          model: c.model,
          promptTokens: c.usage.promptTokens,
          completionTokens: c.usage.completionTokens,
          cacheHitTokens: c.usage.cacheHitTokens,
          cacheMissTokens: c.usage.cacheMissTokens,
          cacheHitRate: c.usage.promptTokens > 0 ? (c.usage.cacheHitTokens / c.usage.promptTokens) * 100 : 0,
          latencyMs: c.latencyMs,
          costUsd: c.costUsd,
        })),
        totalPrompt: calls.reduce((s, c) => s + c.usage.promptTokens, 0),
        totalHit: calls.reduce((s, c) => s + c.usage.cacheHitTokens, 0),
        totalMiss: calls.reduce((s, c) => s + c.usage.cacheMissTokens, 0),
        totalCost: calls.reduce((s, c) => s + c.costUsd, 0),
        totalLatency: calls.reduce((s, c) => s + c.latencyMs, 0),
        hitRate: st ? (st.cacheHitTokens / Math.max(st.totalPromptTokens, 1)) * 100 : 0,
      };

      results.push(benchResult);

      // 实时输出
      const hr = benchResult.hitRate.toFixed(0);
      const status = bench.expected?.minHitRate && benchResult.hitRate < bench.expected.minHitRate ? '❌' : '✅';
      console.log(`   ${status} ${elapsed}s | Prompt:${(benchResult.totalPrompt/1000).toFixed(0)}K | Hit:${hr}% | Cost:$${benchResult.totalCost.toFixed(6)}`);
      if (calls.length > 0) {
        for (const c of calls) {
          console.log(`      ${c.model} ${(c.promptTokens/1000).toFixed(0)}K→${(c.completionTokens/1000).toFixed(0)}K | cache:${c.cacheHitRate.toFixed(0)}% | ${(c.latencyMs/1000).toFixed(1)}s`);
        }
      }
      console.log('');

      // 清理会话避免堆积
      if (result.session) {
        try { await memory.deleteSession(result.session.id); } catch {}
      }

    } catch (e: any) {
      console.log(`   ❌ 失败: ${e.message}\n`);
    }
  }

  // 输出报告
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(OUTPUT_DIR, `${dateStr}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

  // Markdown 报告
  const mdLines: string[] = [
    `# KV Cache Benchmark — ${dateStr}`,
    '',
    `项目: ${path.basename(WORKING_DIR)}`,
    '',
    '| 场景 | ContextPolicy | Prompt(K) | Hit% | Cost($) | 耗时(s) |',
    '|------|-------------|-----------|------|---------|---------|',
  ];
  for (const r of results) {
    mdLines.push(`| ${r.name} | ${r.contextPolicy} | ${(r.totalPrompt/1000).toFixed(0)} | ${r.hitRate.toFixed(0)} | ${r.totalCost.toFixed(6)} | ${(r.totalLatency/1000).toFixed(1)} |`);
  }

  // 关键指标
  const coldAudit = results.find(r => r.name === 'cold_audit');
  const warmAudit = results.find(r => r.name === 'warm_audit_same');
  const recall = results.find(r => r.name === 'conversation_recall');

  mdLines.push('', '## 关键指标', '');
  if (warmAudit) {
    mdLines.push(`- Warm 命中率: ${warmAudit.hitRate.toFixed(0)}% ${warmAudit.hitRate >= 70 ? '✅' : '❌ 目标≥70%'}`);
  }
  if (coldAudit && recall) {
    const ratio = (recall.totalPrompt / Math.max(coldAudit.totalPrompt, 1)) * 100;
    mdLines.push(`- Recall vs Audit: ${ratio.toFixed(0)}% ${ratio <= 20 ? '✅' : '❌ 目标≤20%'}`);
  }
  if (results.length >= 2) {
    mdLines.push(`- 场景数: ${results.length}`, `- 总成本: $${results.reduce((s, r) => s + r.totalCost, 0).toFixed(6)}`);
  }

  const mdPath = path.join(OUTPUT_DIR, `${dateStr}.md`);
  fs.writeFileSync(mdPath, mdLines.join('\n'));

  console.log(`📊 报告已保存:`);
  console.log(`   JSON: ${reportPath}`);
  console.log(`   MD:   ${mdPath}`);
}

main().catch(e => {
  console.error('❌ Benchmark 失败:', e.message);
  process.exit(1);
});

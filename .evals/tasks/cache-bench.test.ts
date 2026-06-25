// ============================================================
// KV Cache 真实基准 + 质量守恒验证
// ============================================================

import { describe, it, expect, afterAll } from 'vitest';
import { runAgentLoop } from '../../packages/core/src/agent/loop.js';
import { ModelRouter } from '../../packages/core/src/model/router.js';
import { createToolExecutors } from '../../packages/core/src/tools/executors.js';
import { FileMemoryStore } from '../../packages/core/src/context/memory.js';
import { PermissionManager, createDefaultPermissionConfig } from '../../packages/core/src/safety/permissions.js';
import { validateReportAnchors } from '../../packages/core/src/agent/report-validator.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const WORKING_DIR = process.cwd();
const OUTPUT_DIR = path.join(WORKING_DIR, '.evals', 'cache-reports');

function getApiKey(): string {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;
  try {
    const configPath = path.join(os.homedir(), '.deepseek-code', 'config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8')).apiKey || '';
    }
  } catch {}
  return '';
}
function getBaseUrl(): string { return process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'; }

interface BenchResult {
  name: string;
  hitRate: number;
  totalPrompt: number;
  totalHit: number;
  totalCost: number;
  totalLatency: number;
  calls: Array<{ model: string; promptK: number; hitRate: number; cost: number }>;
  toolSequence: string[];
  auditSeedSequence: string[];
  quality: {
    findingsCount: number;
    retryCount: number;
    degradedReport: boolean;
    fakePaths: number;
    missingLocations: boolean;
    unmatchedFindings: boolean;
    outputLength: number;
  };
}

const results: BenchResult[] = [];

describe('KV Cache Benchmark + Quality', () => {
  it('cold_audit — 冷启动代码审查', { timeout: 300000 }, async () => {
    const apiKey = getApiKey();
    if (!apiKey) { console.warn('⏭ 跳过: 无 DEEPSEEK_API_KEY'); return; }
    const r = await runBench('cold_audit', '审查代码安全性', 'full_agent', 3, true);
    expect(r.calls.length).toBeGreaterThan(0);
    expect(r.quality.fakePaths).toBe(0);
    results.push(r);
  });

  it('warm_audit_same — 同任务温启动', { timeout: 300000 }, async () => {
    const apiKey = getApiKey();
    if (!apiKey) return;
    const r = await runBench('warm_audit_same', '审查代码安全性', 'full_agent', 3, true);
    results.push(r);
  });

  it('conversation_recall — 对话回顾', { timeout: 120000 }, async () => {
    const apiKey = getApiKey();
    if (!apiKey) return;
    const r = await runBench('conversation_recall', '刚才分析了什么', 'session_state', 1, false);
    results.push(r);
  });
});

function toolSequenceSimilarity(a: string[], b: string[]): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) same++;
  }
  return same / maxLen;
}

function toolFamily(name: string): string {
  if (/^read_file$|^read_file_batch$|^read_package_json$|^read_project_rules$/.test(name)) return 'read';
  if (/^search_code$|^find_references$/.test(name)) return 'search';
  if (/^glob$|^list_files$/.test(name)) return 'discovery';
  if (/^git_status$|^git_diff$/.test(name)) return 'git';
  return 'other';
}

function toolFamilySimilarity(a: string[], b: string[]): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (toolFamily(a[i]) === toolFamily(b[i])) same++;
  }
  return same / maxLen;
}

async function runBench(
  name: string, task: string,
  contextPolicy: 'session_state' | 'full_agent',
  maxSteps: number, isReport: boolean,
): Promise<BenchResult> {
  const apiKey = getApiKey(), baseUrl = getBaseUrl();
  const router = new ModelRouter({ strategy: 'auto', config: { apiKey, baseUrl } });
  const tools = createToolExecutors({ workingDir: WORKING_DIR });
  const memory = new FileMemoryStore(WORKING_DIR);
  const permManager = new PermissionManager(createDefaultPermissionConfig());

  console.log(`\n🚀 ${name}: "${task}" (${contextPolicy})`);
  const start = Date.now();

  const r = await runAgentLoop(task, {
    workingDir: WORKING_DIR, router, tools, memory,
    readOnly: true, streaming: isReport, permissionManager: permManager,
    maxSteps, contextPolicy,
    onConfirm: async () => true,
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const st = r.session?.stats;
  const calls = st?.modelCalls ?? [];
  const hr = st ? ((st.cacheHitTokens / Math.max(st.totalPromptTokens, 1)) * 100).toFixed(0) : '0';

  // 质量指标
  const sess = r.session;
  const finalStep = sess?.steps?.filter(s => s.type === 'final').pop();
  const finalContent = finalStep?.content ?? r.summary ?? '';
  const retryCount = sess?.steps?.filter(s => s.type === 'interruption' && s.content?.includes('retry')).length ?? 0;
  const degradedReport = finalContent.includes('详细分析未能生成');

  let v: ReturnType<typeof validateReportAnchors> | null = null;
  if (isReport && finalContent.length >= 200) {
    v = validateReportAnchors(finalContent, sess?.knownFiles ?? [], { allowShortAnswer: false, findings: sess?.findings ?? [] });
  }

  const quality = {
    findingsCount: sess?.findings?.length ?? 0,
    retryCount,
    degradedReport,
    fakePaths: v?.fakePaths?.length ?? 0,
    missingLocations: v?.reason === 'missing_locations',
    unmatchedFindings: v?.reason === 'unmatched_findings',
    outputLength: finalContent.length,
  };

  const qLabel = isReport
    ? ` | 发现:${quality.findingsCount} 重试:${retryCount} 假路径:${quality.fakePaths} ${quality.degradedReport ? '降级!' : quality.missingLocations ? '缺行号' : quality.unmatchedFindings ? '不匹配' : '✅'}`
    : '';
  console.log(`   ${elapsed}s | Prompt:${((st?.totalPromptTokens??0)/1000).toFixed(0)}K | Hit:${hr}% | Cost:$${(st?.estimatedCostUsd??0).toFixed(6)}${qLabel}`);
  for (const c of calls) {
    const ch = c.usage.promptTokens > 0 ? ((c.usage.cacheHitTokens / c.usage.promptTokens) * 100).toFixed(0) : '0';
    console.log(`      ${c.model} ${(c.usage.promptTokens/1000).toFixed(0)}K→${(c.usage.completionTokens/1000).toFixed(0)}K | cache:${ch}% | ${(c.latencyMs/1000).toFixed(1)}s`);
  }

  if (r.session) { try { await memory.deleteSession(r.session.id); } catch {} }

  return {
    name, quality,
    hitRate: st ? (st.cacheHitTokens / Math.max(st.totalPromptTokens, 1)) * 100 : 0,
    totalPrompt: st?.totalPromptTokens ?? 0, totalHit: st?.cacheHitTokens ?? 0,
    totalCost: st?.estimatedCostUsd ?? 0, totalLatency: Date.now() - start,
    toolSequence: st?.toolSequence ?? [],
    auditSeedSequence: st?.auditSeedSequence ?? [],
    calls: calls.map(c => ({
      model: c.model, promptK: c.usage.promptTokens / 1000,
      hitRate: c.usage.promptTokens > 0 ? (c.usage.cacheHitTokens / c.usage.promptTokens) * 100 : 0,
      cost: c.costUsd,
    })),
  };
}

afterAll(() => {
  if (results.length === 0) return;
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);

  fs.writeFileSync(path.join(OUTPUT_DIR, `${dateStr}.json`), JSON.stringify(results, null, 2));

  const mdLines = [
    '# KV Cache Benchmark — ' + dateStr,
    '', '项目: ' + path.basename(WORKING_DIR), '',
    '| 场景 | Prompt(K) | Hit% | Cost($) | 耗时(s) | Tools | 发现数 | 假路径 | 重试 | 降级 |',
    '|------|-----------|------|---------|---------|-------|--------|--------|------|------|',
  ];
  for (const r of results) {
    mdLines.push(`| ${r.name} | ${(r.totalPrompt/1000).toFixed(0)} | ${r.hitRate.toFixed(0)} | ${r.totalCost.toFixed(6)} | ${(r.totalLatency/1000).toFixed(1)} | ${r.toolSequence.length} | ${r.quality.findingsCount} | ${r.quality.fakePaths} | ${r.quality.retryCount} | ${r.quality.degradedReport ? '⚠️' : '-'} |`);
  }

  const cold = results.find(r => r.name === 'cold_audit');
  const warm = results.find(r => r.name === 'warm_audit_same');
  const recall = results.find(r => r.name === 'conversation_recall');

  mdLines.push('', '## 关键指标', '');
  if (warm) mdLines.push(`- Warm 命中率: ${warm.hitRate.toFixed(0)}% ${warm.hitRate >= 70 ? '✅' : '❌ 目标≥70%'}`);
  if (cold && recall) {
    mdLines.push(`- Recall vs Audit: ${((recall.totalPrompt / Math.max(cold.totalPrompt, 1)) * 100).toFixed(0)}% ${recall.totalPrompt / cold.totalPrompt <= 0.2 ? '✅' : '❌'}`);
  }
  if (cold && warm) {
    const seedSim = toolSequenceSimilarity(cold.auditSeedSequence, warm.auditSeedSequence);
    const coldModel = cold.toolSequence.slice(cold.auditSeedSequence.length);
    const warmModel = warm.toolSequence.slice(warm.auditSeedSequence.length);
    const modelSim = toolSequenceSimilarity(coldModel, warmModel);
    const totalSim = toolSequenceSimilarity(cold.toolSequence, warm.toolSequence);
    const familySim = toolFamilySimilarity(coldModel, warmModel);
    mdLines.push(`- Tool Similarity: total=${(totalSim*100).toFixed(0)}% seed=${(seedSim*100).toFixed(0)}% model=${(modelSim*100).toFixed(0)}% family=${(familySim*100).toFixed(0)}%`);
    mdLines.push(`- Seed: ${cold.auditSeedSequence.join(' → ')}`);
    mdLines.push(`- Cold model: ${coldModel.join(' → ') || '(none)'}`);
    mdLines.push(`- Warm model: ${warmModel.join(' → ') || '(none)'}`);
    if (modelSim < 0.5) mdLines.push(`- ⚠️ 模型工具分叉(${(modelSim*100).toFixed(0)}%)，需优化 planner`);
  }

  mdLines.push('', '## 质量门禁', '');
  for (const r of results.filter(x => x.quality.findingsCount > 0 || x.quality.outputLength > 200)) {
    const q = r.quality;
    const gates = [
      q.fakePaths === 0 ? '✅' : `❌假路径${q.fakePaths}`,
      !q.missingLocations ? '✅' : '⚠️缺行号',
      !q.unmatchedFindings ? '✅' : '⚠️不匹配',
      !q.degradedReport ? '✅' : '❌降级',
    ];
    mdLines.push(`- ${r.name}: ${gates.join(' ')} | 发现${q.findingsCount} | 重试${q.retryCount}`);
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, `${dateStr}.md`), mdLines.join('\n'));
  console.log(`\n📊 报告: ${OUTPUT_DIR}/${dateStr}.json | ${dateStr}.md`);
});

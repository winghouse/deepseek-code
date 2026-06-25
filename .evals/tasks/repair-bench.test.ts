// ============================================================
// Repair Path Benchmark — 验证 repair seed 路径稳定性
// 不评估修复质量，只看第一刀是否打在正确位置
// ============================================================

import { describe, it, afterAll } from 'vitest';
import { runAgentLoop } from '../../packages/core/src/agent/loop.js';
import { ModelRouter } from '../../packages/core/src/model/router.js';
import { createToolExecutors } from '../../packages/core/src/tools/executors.js';
import { FileMemoryStore } from '../../packages/core/src/context/memory.js';
import { PermissionManager, createDefaultPermissionConfig } from '../../packages/core/src/safety/permissions.js';
import cases from '../fixtures/repair-cases.json';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const WORKING_DIR = process.cwd();
const OUTPUT_DIR = path.join(WORKING_DIR, '.evals', 'cache-reports');

function getApiKey(): string {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;
  try {
    const p = path.join(os.homedir(), '.deepseek-code', 'config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')).apiKey || '';
  } catch {}
  return '';
}
function getBaseUrl(): string { return process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'; }

interface RepairResult {
  id: string;
  seedHits: number;
  seedExpected: number;
  seedSimilarity: number;
  seedTriggered: boolean;
  expectedTrigger: boolean;
  seedUseful: boolean;
  firstModelTool: string;
  firstUseful: boolean;
  modelRedundantRead: boolean;
  modelFullScan: boolean;
  noFullRepoScan: boolean;
  diffChecked: boolean;
  filesRead: number;
  toolSequence: string[];
  outputLength: number;
}

const results: RepairResult[] = [];
const apiKey = getApiKey();
const hasApi = !!apiKey;

describe('Repair Path Benchmark', () => {
  for (const c of cases) {
    const maxSteps = c.id === 'no-anchor-vague-error' ? 1 : 3;
    it(`${c.id} → ${c.expectedFirstUsefulTool}`, { timeout: 300000, skip: !hasApi }, async () => {
      if (!hasApi) { console.log(`⏭ ${c.id}: 无 API Key`); return; }
      const r = await runRepairCase(c as any, maxSteps);
      results.push(r);
      console.log(`   seed:${(r.seedSimilarity*100).toFixed(0)}% first:${r.firstModelTool} diff:${r.diffChecked} files:${r.filesRead} scan:${!r.noFullRepoScan}`);
    });
  }
});

async function runRepairCase(c: typeof cases[0], maxSteps: number): Promise<RepairResult> {
  const apiKey = getApiKey(), baseUrl = getBaseUrl();
  const router = new ModelRouter({ strategy: 'auto', config: { apiKey, baseUrl } });
  const tools = createToolExecutors({ workingDir: WORKING_DIR });
  const memory = new FileMemoryStore(WORKING_DIR);
  const permManager = new PermissionManager(createDefaultPermissionConfig());

  console.log(`\n🔧 ${c.id}: "${c.input.slice(0, 60)}"`);
  const r = await runAgentLoop(c.input, {
    workingDir: WORKING_DIR, router, tools, memory,
    readOnly: true, streaming: false, permissionManager: permManager,
    maxSteps, contextPolicy: 'project_summary',
    onConfirm: async () => true,
  });

  const sess = r.session;
  const seedSeq: string[] = ((sess as any)?.__auditSeedToolSequence as string[]) ?? [];
  const seedTriggered = seedSeq.length > 0;
  const expectedTrigger = (c as any).expectedTrigger ?? true;
  const st = sess?.stats;
  const modelSeq = (st?.toolSequence ?? []).slice(seedSeq.length);

  const seedHits = seedTriggered
    ? seedSeq.filter((s, i) => s === (c as any).expectedSeed[i]).length
    : 0;
  const seedSim = (c as any).expectedSeed.length > 0 ? seedHits / (c as any).expectedSeed.length : 1;

  const firstModel = modelSeq[0] || 'none';
  const firstUseful = firstModel === (c as any).expectedFirstUsefulTool
    || ((c as any).expectedFirstUsefulTool === 'clarify' && modelSeq.length === 0);
  const seedUseful = seedSeq.includes('read_file_range') || seedSeq.includes('search_code');
  const modelRedundantRead = seedUseful && modelSeq.some(t => t === 'read_file');
  const modelFullScan = modelSeq.some(t => /^(glob|list_files)$/i.test(t));
  const noFullRepoScan = !modelFullScan;
  const diffChecked = seedSeq.includes('git_diff') || modelSeq.includes('git_diff');
  const readTools = modelSeq.filter(t => /^read_file|read_file_range|read_file_batch/.test(t));
  const filesRead = readTools.length;

  const finalStep = sess?.steps?.filter(s => s.type === 'final').pop();
  const outLen = (finalStep?.content ?? r.summary ?? '').length;

  if (r.session) { try { await memory.deleteSession(r.session.id); } catch {} }

  return {
    id: c.id,
    seedHits, seedExpected: (c as any).expectedSeed.length, seedSimilarity: seedSim,
    seedTriggered, expectedTrigger, seedUseful,
    firstModelTool: firstModel, firstUseful, modelRedundantRead, modelFullScan,
    noFullRepoScan, diffChecked, filesRead,
    toolSequence: modelSeq, outputLength: outLen,
  };
}

afterAll(() => {
  if (results.length === 0) return;
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);

  fs.writeFileSync(path.join(OUTPUT_DIR, `repair-${dateStr}.json`), JSON.stringify(results, null, 2));

  const mdLines = [
    '# Repair Path Benchmark — ' + dateStr,
    '', '项目: ' + path.basename(WORKING_DIR), '',
    '| 场景 | Seed% | 触发? | 首个工具 | 有用? | 读文件 | 全仓扫? | 查diff? |',
    '|------|-------|-------|----------|-------|--------|---------|---------|',
  ];
  for (const r of results) {
    const triggerOk = r.seedTriggered === r.expectedTrigger;
    mdLines.push(`| ${r.id} | ${(r.seedSimilarity*100).toFixed(0)} | ${triggerOk ? (r.seedTriggered ? '✅' : '✅skip') : '❌'} | ${r.firstModelTool} | ${r.firstUseful ? '✅' : '❌'} | ${r.filesRead} | ${r.noFullRepoScan ? '-' : '⚠️'} | ${r.diffChecked ? '✅' : '❌'} |`);
  }

  // 诊断汇总 (排除边界 case)
  const repairCases = results.filter(r => r.expectedTrigger);
  const n = repairCases.length;
  const seedUsefulRate = n > 0 ? repairCases.filter(r => r.seedUseful).length / n : 0;
  const modelRedundantReadRate = n > 0 ? repairCases.filter(r => r.modelRedundantRead).length / n : 0;
  const modelFullScanRate = n > 0 ? repairCases.filter(r => r.modelFullScan).length / n : 0;
  const firstUsefulRate = n > 0 ? repairCases.filter(r => r.firstUseful).length / n : 0;
  const noScanRate = n > 0 ? repairCases.filter(r => r.noFullRepoScan).length / n : 0;
  const diffRate = n > 0 ? repairCases.filter(r => r.diffChecked).length / n : 0;
  const filesReads = repairCases.map(r => r.filesRead).sort((a, b) => a - b);
  const filesReadMedian = filesReads.length > 0 ? filesReads[Math.floor(filesReads.length / 2)] : 0;

  mdLines.push('', '## 诊断汇总 (repair cases)', '');
  mdLines.push(`- seedUsefulRate: ${(seedUsefulRate*100).toFixed(0)}% ${seedUsefulRate>=0.9?'✅':'❌ 目标≥90%'}`);
  mdLines.push(`- modelRedundantReadRate: ${(modelRedundantReadRate*100).toFixed(0)}% ${modelRedundantReadRate<=0.2?'✅':'❌ 目标≤20%'}`);
  mdLines.push(`- modelFullScanRate: ${(modelFullScanRate*100).toFixed(0)}% ${modelFullScanRate===0?'✅':'❌ 目标0%'}`);
  mdLines.push(`- firstUsefulToolRate: ${(firstUsefulRate*100).toFixed(0)}% ${firstUsefulRate>=0.6?'✅':'⬆️ 目标≥60%'}`);
  mdLines.push(`- noFullRepoScanRate: ${(noScanRate*100).toFixed(0)}% ${noScanRate>=0.95?'✅':'⬆️ 目标≥95%'}`);
  mdLines.push(`- diffCheckedRate: ${(diffRate*100).toFixed(0)}% ${diffRate>=1?'✅':'❌ 目标100%'}`);
  mdLines.push(`- filesReadMedian: ${filesReadMedian} ${filesReadMedian<=3?'✅':'❌ 目标≤3'}`);

  // 边界验证
  const boundaryCases = results.filter(r => !r.expectedTrigger);
  if (boundaryCases.length > 0) {
    mdLines.push('', '## 边界验证', '');
    for (const b of boundaryCases) {
      mdLines.push(`- ${b.id}: seed触发=${b.seedTriggered} ${b.seedTriggered ? '❌不应触发repair' : '✅正确免触发'}`);
    }
  }

  // 问题定位
  const problems = results.filter(r => !r.firstUseful || !r.noFullRepoScan || !r.diffChecked);
  if (problems.length > 0) {
    mdLines.push('', '## 需修复', '');
    for (const p of problems) {
      const issues: string[] = [];
      if (!p.firstUseful) issues.push(`首个工具 ${p.firstModelTool} ≠ 期望`);
      if (!p.noFullRepoScan) issues.push('使用了 glob/list_files 全仓扫');
      if (!p.diffChecked) issues.push('未检查 git_diff');
      mdLines.push(`- **${p.id}**: ${issues.join('; ')}`);
    }
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, `repair-${dateStr}.md`), mdLines.join('\n'));
  console.log(`\n📊 报告: ${OUTPUT_DIR}/repair-${dateStr}.json | ${dateStr}.md`);
});

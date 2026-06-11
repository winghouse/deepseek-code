// ============================================================
// Task Eval — 真实任务评测框架
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RouteDecision, ToolExecutionResult } from 'deepseek-code-shared';

// ═══ Types ═══

export interface TaskEvalCase {
  id: string;
  suite: string;
  risk: 'P0' | 'P1' | 'P2';
  task: string;
  mode: 'readonly' | 'ask' | 'auto';
  description?: string;
  /** fixture 所在目录名 */
  caseDir: string;
  /** fixture 所在完整路径 */
  casePath: string;
  /** 初始上下文(conversationFocus/pendingAction/lastExternalResource等) */
  context?: Record<string, unknown>;
  /** Mock LLM Router 输出——离线模式注入, 跳过真实 LLM 调用 */
  mockLLMRouter?: Partial<RouteDecision>;
  expected: {
    route?: Partial<RouteDecision>;
    mustReadFiles?: string[];
    mustNotUseTools?: string[];
    outputMustContain?: string[];
    outputMustNotContain?: string[];
    maxToolCalls?: number;
    maxDurationMs?: number;
  };
}

export interface TaskEvalScore {
  routeCorrect: boolean;
  routeDetail: string;
  filesRead: number;
  filesExpected: number;
  filesHit: number;
  filesScore: number;
  outputHits: number;
  outputExpected: number;
  outputScore: number;
  outputNegativeHits: number;
  toolCallsUsed: number;
  toolCallsOk: boolean;
  safetyOk: boolean;
}

export interface TaskEvalResult {
  caseId: string;
  suite: string;
  risk: 'P0' | 'P1' | 'P2';
  passed: boolean;
  score: TaskEvalScore;
  failures: string[];
  routeActual?: Partial<RouteDecision>;
  outputPreview?: string;
  durationMs: number;
  /** 评测模式: mock=离线注入 / live-router=真实LLM路由 / live-task=真实LLM+pipeline */
  evalMode: 'mock' | 'live-router' | 'live-task';
}

export interface TaskEvalReport {
  total: number;
  passed: number;
  failed: number;
  p0Total: number;
  p0Failed: number;
  evalMode: string;
  /** 按意图的准确率（mock模式下反映fixture质量, live模式下反映LLM Router质量） */
  mockRouteAccuracy: number;
  liveRouteAccuracy: number;
  taskE2ESuccess: number;
  safetyInvariantPass: number;
  avgFilesScore: number;
  avgOutputScore: number;
  results: TaskEvalResult[];
  suiteStats: Record<string, { total: number; passed: number; avgScore: number }>;
}

// ═══ Fixture Loading ═══

/** 从 fixtures 目录加载所有 task.json */
export function loadTaskFixtures(fixturesDir: string): TaskEvalCase[] {
  const cases: TaskEvalCase[] = [];

  if (!fs.existsSync(fixturesDir)) return cases;

  for (const suiteDir of fs.readdirSync(fixturesDir)) {
    const suitePath = path.join(fixturesDir, suiteDir);
    if (!fs.statSync(suitePath).isDirectory()) continue;

    for (const caseDir of fs.readdirSync(suitePath)) {
      const casePath = path.join(suitePath, caseDir);
      const taskPath = path.join(casePath, 'task.json');
      if (!fs.existsSync(taskPath)) continue;

      try {
        const taskJson = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
        cases.push({
          id: taskJson.id,
          suite: taskJson.suite,
          risk: taskJson.risk,
          task: taskJson.task,
          mode: taskJson.mode || 'readonly',
          description: taskJson.description,
          caseDir,
          casePath,
          context: taskJson.context,
          mockLLMRouter: taskJson.mockLLMRouter,
          expected: {
            route: taskJson.expected?.route,
            mustReadFiles: taskJson.expected?.mustReadFiles,
            mustNotUseTools: taskJson.expected?.mustNotUseTools,
            outputMustContain: taskJson.expected?.outputMustContain,
            outputMustNotContain: taskJson.expected?.outputMustNotContain,
            maxToolCalls: taskJson.expected?.maxToolCalls,
            maxDurationMs: taskJson.expected?.maxDurationMs,
          },
        } as TaskEvalCase);
      } catch {
        // skip invalid fixtures
      }
    }
  }

  return cases;
}

// ═══ Scoring ═══

interface EvalRunContext {
  routeResult: RouteDecision;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result?: ToolExecutionResult }>;
  outputText: string;
  durationMs: number;
  evalMode: 'mock' | 'live-router' | 'live-task';
}

/**
 * 对一个 fixture 评分
 */
export function scoreTaskEval(
  taskCase: TaskEvalCase,
  context: EvalRunContext,
): TaskEvalResult {
  const failures: string[] = [];
  const { expected } = taskCase;

  // 1. Route check
  let routeCorrect = true;
  const routeDetails: string[] = [];
  if (expected.route) {
    if (expected.route.intent && context.routeResult.intent !== expected.route.intent) {
      routeCorrect = false;
      routeDetails.push(`intent: 期望=${expected.route.intent} 实际=${context.routeResult.intent}`);
    }
    if (expected.route.execution && context.routeResult.execution !== expected.route.execution) {
      routeCorrect = false;
      routeDetails.push(`execution: 期望=${expected.route.execution} 实际=${context.routeResult.execution}`);
    }
  }

  // 2. Files check
  let filesHit = 0;
  const filesExpected = expected.mustReadFiles?.length || 0;
  const readFiles = new Set(
    context.toolCalls
      .filter(t => t.name === 'read_file' || t.name === 'read_file_range')
      .map(t => t.args.filePath as string),
  );

  if (expected.mustReadFiles) {
    for (const f of expected.mustReadFiles) {
      // 检查是否有文件包含目标路径
      const found = [...readFiles].some(rf => rf.includes(f) || f.includes(rf));
      if (found) filesHit++;
    }
  }
  const filesScore = filesExpected > 0 ? filesHit / filesExpected : 1;

  if (filesExpected > 0 && filesHit < filesExpected) {
    failures.push(`文件读取: ${filesHit}/${filesExpected} (期望: ${expected.mustReadFiles?.join(', ')})`);
  }

  // 3. Output content check
  let outputHits = 0;
  const outputExpected = expected.outputMustContain?.length || 0;
  const outputTextLower = context.outputText.toLowerCase();

  if (expected.outputMustContain) {
    for (const keyword of expected.outputMustContain) {
      if (outputTextLower.includes(keyword.toLowerCase())) {
        outputHits++;
      }
    }
  }
  const outputScore = outputExpected > 0 ? outputHits / outputExpected : 1;

  let outputNegativeHits = 0;
  if (expected.outputMustNotContain) {
    for (const bad of expected.outputMustNotContain) {
      if (outputTextLower.includes(bad.toLowerCase())) {
        outputNegativeHits++;
        failures.push(`输出不应包含: "${bad}"`);
      }
    }
  }

  // 4. Tool call count
  const toolCallsOk = expected.maxToolCalls
    ? context.toolCalls.length <= expected.maxToolCalls
    : true;
  if (!toolCallsOk) {
    failures.push(`工具调用: ${context.toolCalls.length} > ${expected.maxToolCalls} (上限)`);
  }

  // 5. Safety invariant: readonly 模式下不应有写工具
  const writeTools = ['apply_patch', 'write_file', 'run_cmd', 'run_command'];
  const writeCalls = context.toolCalls.filter(t => writeTools.includes(t.name));
  const safetyOk = taskCase.mode === 'readonly' ? writeCalls.length === 0 : true;
  if (!safetyOk) {
    failures.push(`安全: readonly 模式调用了写工具: ${writeCalls.map(t => t.name).join(', ')}`);
  }

  // 6. mustNotUseTools: 禁止使用的工具
  if (expected.mustNotUseTools) {
    for (const forbidden of expected.mustNotUseTools) {
      if (context.toolCalls.some(t => t.name === forbidden)) {
        failures.push(`禁止工具: 使用了 ${forbidden}`);
      }
    }
  }

  // 综合评分
  const score: TaskEvalScore = {
    routeCorrect,
    routeDetail: routeDetails.join('; ') || 'OK',
    filesRead: readFiles.size,
    filesExpected,
    filesHit,
    filesScore,
    outputHits,
    outputExpected,
    outputScore,
    outputNegativeHits,
    toolCallsUsed: context.toolCalls.length,
    toolCallsOk,
    safetyOk,
  };

  const passed = routeCorrect && filesScore >= 0.5 && outputScore >= 0.3 && toolCallsOk && safetyOk && outputNegativeHits === 0;

  if (!routeCorrect) failures.unshift(`路由错误: ${routeDetails.join('; ')}`);

  return {
    caseId: taskCase.id,
    suite: taskCase.suite,
    risk: taskCase.risk,
    passed,
    score,
    failures,
    routeActual: {
      intent: context.routeResult.intent,
      execution: context.routeResult.execution,
      shouldScanProject: context.routeResult.shouldScanProject,
    },
    outputPreview: context.outputText.slice(0, 200),
    durationMs: context.durationMs,
    evalMode: context.evalMode,
  };
}

// ═══ Report Generation ═══

/**
 * 生成评测报告
 */
export function generateTaskEvalReport(results: TaskEvalResult[]): TaskEvalReport {
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;

  const p0Results = results.filter(r => r.risk === 'P0');
  const p0Total = p0Results.length;
  const p0Failed = p0Results.filter(r => !r.passed).length;

  const mockResults = results.filter(r => r.evalMode === 'mock');
  const liveRouterResults = results.filter(r => r.evalMode === 'live-router');
  const liveTaskResults = results.filter(r => r.evalMode === 'live-task');

  const mockRouteAcc = mockResults.length > 0 ? mockResults.filter(r => r.score.routeCorrect).length / mockResults.length : 0;
  const liveRouteAcc = liveRouterResults.length > 0 ? liveRouterResults.filter(r => r.score.routeCorrect).length / liveRouterResults.length : 0;
  const taskE2E = liveTaskResults.length > 0 ? liveTaskResults.filter(r => r.passed).length / liveTaskResults.length : 0;
  const safetyInvariant = results.filter(r => r.score.safetyOk).length / Math.max(total, 1);

  const avgFilesScore = total > 0 ? results.reduce((s, r) => s + r.score.filesScore, 0) / total : 0;
  const avgOutputScore = total > 0 ? results.reduce((s, r) => s + r.score.outputScore, 0) / total : 0;

  const mode = [...new Set(results.map(r => r.evalMode))].join('+');

  // 按套件统计
  const suiteStats: Record<string, { total: number; passed: number; avgScore: number }> = {};
  for (const r of results) {
    if (!suiteStats[r.suite]) suiteStats[r.suite] = { total: 0, passed: 0, avgScore: 0 };
    suiteStats[r.suite].total++;
    if (r.passed) suiteStats[r.suite].passed++;
    suiteStats[r.suite].avgScore += (r.score.routeCorrect ? 0.25 : 0) + r.score.filesScore * 0.25 + r.score.outputScore * 0.25 + (r.score.safetyOk ? 0.25 : 0);
  }
  for (const s of Object.values(suiteStats)) {
    s.avgScore = s.total > 0 ? s.avgScore / s.total : 0;
  }

  return {
    total, passed, failed, p0Total, p0Failed,
    evalMode: mode,
    mockRouteAccuracy: Math.round(mockRouteAcc * 100),
    liveRouteAccuracy: Math.round(liveRouteAcc * 100),
    taskE2ESuccess: Math.round(taskE2E * 100),
    safetyInvariantPass: Math.round(safetyInvariant * 100),
    avgFilesScore: Math.round(avgFilesScore * 100),
    avgOutputScore: Math.round(avgOutputScore * 100),
    results,
    suiteStats,
  };
}

/**
 * 格式化报告为可读文本
 */
export function formatTaskEvalReport(report: TaskEvalReport): string {
  const lines: string[] = [];
  lines.push('═══════════════════════════════════════');
  lines.push('  dscode Task Eval 报告');
  lines.push('═══════════════════════════════════════');
  lines.push(`  模式: ${report.evalMode}  |  总数: ${report.total}  |  通过: ${report.passed}  |  失败: ${report.failed}`);
  lines.push(`  P0 失败: ${report.p0Failed}/${report.p0Total}  |  安全不变式: ${report.safetyInvariantPass}%`);
  lines.push(`  Mock路由准确率: ${report.mockRouteAccuracy}%  |  Live路由准确率: ${report.liveRouteAccuracy}%`);
  lines.push(`  Task E2E成功率: ${report.taskE2ESuccess}%  |  安全不变式: ${report.safetyInvariantPass}%`);
  lines.push(`  文件命中率: ${report.avgFilesScore}%  |  输出命中率: ${report.avgOutputScore}%`);
  lines.push('');
  lines.push('═══ 按套件 ═══');

  for (const [suite, s] of Object.entries(report.suiteStats).sort()) {
    const pct = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0;
    const bar = '█'.repeat(Math.round(s.avgScore * 20)) + '░'.repeat(20 - Math.round(s.avgScore * 20));
    lines.push(`  ${suite}: ${s.passed}/${s.total} (${pct}%) [${bar}] ${(s.avgScore * 100).toFixed(0)}%`);
  }

  lines.push('');
  lines.push('═══ 详细结果 ═══');

  for (const r of report.results) {
    const icon = r.passed ? '✅' : '❌';
    const dur = `${r.durationMs}ms`;
    lines.push(`  ${icon} [${r.risk}] ${r.suite}/${r.caseId} (${dur})`);
    if (!r.passed) {
      for (const f of r.failures) {
        lines.push(`      ❌ ${f}`);
      }
    }
    // 路由信息
    if (r.routeActual) {
      lines.push(`      route: intent=${r.routeActual.intent} exec=${r.routeActual.execution}`);
    }
  }

  if (report.p0Failed > 0) {
    lines.push('');
    lines.push(`🔴 P0 失败 (${report.p0Failed} 条):`);
    for (const r of report.results.filter(r => r.risk === 'P0' && !r.passed)) {
      lines.push(`  ${r.caseId}: ${r.failures.join(', ')}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

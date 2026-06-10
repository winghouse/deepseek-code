// ============================================================
// Router Eval Framework — 评测 + 评分 + 报告
// ============================================================

import type { RouteDecision, RouteTrace, RouterEvalCase } from 'deepseek-code-shared';

export interface EvalResult {
  caseId: string;
  suite: string;
  passed: boolean;
  details: string[];
  expected: Partial<RouteDecision>;
  actual: Partial<RouteDecision>;
  trace?: RouteTrace;
  risk: 'P0' | 'P1' | 'P2';
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  intentAccuracy: number;
  executionAccuracy: number;
  scanAccuracy: number;
  toolInvariantPass: number;
  llmFallbackCount: number;
  heuristicHitRate: number;
  p0Failures: number;
  p1Failures: number;
  p2Failures: number;
  results: EvalResult[];
  confusionPairs: Array<{ expected: string; actual: string; count: number }>;
  suiteStats: Record<string, { total: number; passed: number }>;
}

/** 评测单条 case */
export async function evaluateRouterCase(
  testCase: RouterEvalCase,
  routeInputFn: (input: string, ctx: any, llmClient?: any) => Promise<RouteDecision & { trace?: RouteTrace }>,
  llmClient?: any,
): Promise<EvalResult> {
  const details: string[] = [];
  const ctx = {
    mode: testCase.mode,
    projectName: testCase.context?.project?.name,
    projectPath: testCase.context?.project?.path,
    lastAgentResult: testCase.context?.lastAgentResult,
    pendingAction: testCase.context?.pendingAction,
  };

  const decision = await routeInputFn(testCase.input, ctx, llmClient);
  const trace = decision.trace;
  let passed = true;

  // Check intent
  if (testCase.expected.intent) {
    if (decision.intent !== testCase.expected.intent) {
      const altMatch = testCase.acceptedAlternatives?.some(
        (a) => a.intent === decision.intent,
      );
      if (!altMatch) {
        passed = false;
        details.push(`intent: expected ${testCase.expected.intent}, got ${decision.intent}`);
      }
    }
  }

  // Check execution
  if (testCase.expected.execution) {
    if (decision.execution !== testCase.expected.execution) {
      const altMatch = testCase.acceptedAlternatives?.some(
        (a) => a.execution === decision.execution,
      );
      if (!altMatch) {
        passed = false;
        details.push(`execution: expected ${testCase.expected.execution}, got ${decision.execution}`);
      }
    }
  }

  // Check scanProject
  if (testCase.expected.shouldScanProject !== undefined) {
    if (decision.shouldScanProject !== testCase.expected.shouldScanProject) {
      passed = false;
      details.push(`scanProject: expected ${testCase.expected.shouldScanProject}, got ${decision.shouldScanProject}`);
    }
  }

  // P0 hard rules
  const a = testCase.assertions;

  // local_action must not call LLM（仅适用于命令类输入）
  if (decision.execution === 'local_action' && a?.mustNotCallLLMRouter) {
    if (trace?.llmRouterCalled) {
      passed = false;
      details.push('P0: local_action called LLM Router');
    }
    if (decision.shouldScanProject) {
      passed = false;
      details.push('P0: local_action has shouldScanProject=true');
    }
    if (decision.allowedTools.length > 0) {
      passed = false;
      details.push('P0: local_action has non-empty allowedTools');
    }
  }

  // llm_direct must not scan/enter agent
  if (decision.execution === 'llm_direct') {
    if (decision.shouldScanProject) {
      passed = false;
      details.push('P0: llm_direct has shouldScanProject=true');
    }
    if (decision.allowedTools.length > 0) {
      passed = false;
      details.push('P0: llm_direct has non-empty allowedTools');
    }
  }

  // readonly must not have write tools
  if (testCase.mode === 'readonly') {
    const writeTools = ['apply_patch', 'write_file', 'run_command', 'run_cmd'];
    for (const t of writeTools) {
      if (decision.allowedTools.includes(t)) {
        passed = false;
        details.push(`P0: readonly has write tool: ${t}`);
      }
    }
  }

  // Custom assertions
  if (a?.allowedToolsMustNotContain) {
    for (const t of a.allowedToolsMustNotContain) {
      if (decision.allowedTools.includes(t)) {
        passed = false;
        details.push(`assertion failed: allowedTools must not contain ${t}`);
      }
    }
  }
  if (a?.allowedToolsMustContain) {
    for (const t of a.allowedToolsMustContain) {
      if (!decision.allowedTools.includes(t)) {
        passed = false;
        details.push(`assertion failed: allowedTools must contain ${t}`);
      }
    }
  }
  if (a?.mustNotEnterAgent && ['agent_readonly', 'agent_plan', 'agent_execute'].includes(decision.execution)) {
    passed = false;
    details.push('assertion failed: must not enter Agent');
  }
  if (a?.mustNotScanProject && decision.shouldScanProject) {
    passed = false;
    details.push('assertion failed: must not scan project');
  }

  return {
    caseId: testCase.id,
    suite: testCase.suite,
    passed,
    details,
    expected: { intent: testCase.expected.intent, execution: testCase.expected.execution, shouldScanProject: testCase.expected.shouldScanProject },
    actual: { intent: decision.intent, execution: decision.execution, shouldScanProject: decision.shouldScanProject },
    trace,
    risk: testCase.risk,
  };
}

/** 生成评测报告 */
export function generateEvalReport(results: EvalResult[]): EvalReport {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  const intentOk = results.filter((r) => !r.details.some((d) => d.startsWith('intent:'))).length;
  const execOk = results.filter((r) => !r.details.some((d) => d.startsWith('execution:'))).length;
  const scanOk = results.filter((r) => !r.details.some((d) => d.startsWith('scanProject:'))).length;
  const toolInvariantPass = results.filter((r) => !r.details.some((d) => d.includes('write tool') || d.includes('allowedTools'))).length;
  const llmFallbackCount = results.filter((r) => r.trace?.llmRouterFallbackReason).length;
  const heuristicHit = results.filter((r) => r.trace?.heuristicRouterHit).length;

  const p0Failures = results.filter((r) => !r.passed && r.risk === 'P0').length;
  const p1Failures = results.filter((r) => !r.passed && r.risk === 'P1').length;
  const p2Failures = results.filter((r) => !r.passed && r.risk === 'P2').length;

  // Confusion pairs
  const pairs = new Map<string, number>();
  for (const r of results) {
    if (r.passed) continue;
    const key = `${r.expected.intent ?? r.expected.execution}→${r.actual.intent ?? r.actual.execution}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  const confusionPairs = [...pairs.entries()]
    .map(([k, v]) => { const [expected, actual] = k.split('→'); return { expected, actual, count: v }; })
    .sort((a, b) => b.count - a.count);

  // Suite stats
  const suiteStats: Record<string, { total: number; passed: number }> = {};
  for (const r of results) {
    if (!suiteStats[r.suite]) suiteStats[r.suite] = { total: 0, passed: 0 };
    suiteStats[r.suite].total++;
    if (r.passed) suiteStats[r.suite].passed++;
  }

  return {
    total, passed, failed,
    intentAccuracy: total > 0 ? intentOk / total : 0,
    executionAccuracy: total > 0 ? execOk / total : 0,
    scanAccuracy: total > 0 ? scanOk / total : 0,
    toolInvariantPass: total > 0 ? toolInvariantPass / total : 0,
    llmFallbackCount,
    heuristicHitRate: total > 0 ? heuristicHit / total : 0,
    p0Failures, p1Failures, p2Failures,
    results,
    confusionPairs,
    suiteStats,
  };
}

/** 生成 Markdown 报告 */
export function formatEvalReport(report: EvalReport): string {
  const pct = (n: number, t: number) => t > 0 ? ((n / t) * 100).toFixed(0) + '%' : 'N/A';
  const lines = [
    '# Router Eval Report',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total | ${report.total} |`,
    `| Passed | ${report.passed} |`,
    `| Failed | ${report.failed} |`,
    `| Intent Accuracy | ${pct(report.intentAccuracy * report.total, report.total)} |`,
    `| Execution Accuracy | ${pct(report.executionAccuracy * report.total, report.total)} |`,
    `| Scan Accuracy | ${pct(report.scanAccuracy * report.total, report.total)} |`,
    `| Tool Invariant | ${pct(report.toolInvariantPass * report.total, report.total)} |`,
    `| Heuristic Hit Rate | ${pct(report.heuristicHitRate * report.total, report.total)} |`,
    `| LLM Fallback | ${report.llmFallbackCount} |`,
    `| P0 Failures | ${report.p0Failures} |`,
    `| P1 Failures | ${report.p1Failures} |`,
    `| P2 Failures | ${report.p2Failures} |`,
    '',
    '## Suite Breakdown',
    '',
    ...Object.entries(report.suiteStats).flatMap(([suite, s]) => [
      `| ${suite} | ${s.passed}/${s.total} (${pct(s.passed, s.total)}) |`,
    ]),
    '',
  ];

  if (report.confusionPairs.length > 0) {
    lines.push('## Confusion Matrix', '');
    for (const p of report.confusionPairs) {
      lines.push(`| ${p.expected} → ${p.actual} | ${p.count} |`);
    }
  }

  if (report.failed > 0) {
    lines.push('', '## Failures', '');
    for (const r of report.results.filter((r) => !r.passed)) {
      lines.push(`### ${r.caseId} [${r.risk}]`, '');
      lines.push(`Expected: ${r.expected.intent ?? r.expected.execution}→${r.expected.execution}`);
      lines.push(`Actual: ${r.actual.intent ?? r.actual.execution}→${r.actual.execution}`);
      for (const d of r.details) lines.push(`- ${d}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

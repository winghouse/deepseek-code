// ============================================================
// Fix Verification Pipeline — "哪些已经修复了" 专用
// 最小版: session findings + git diff → fixed/partial/unknown
// ============================================================

import type { Session } from 'deepseek-code-shared';

// ═══ 共享常量 ═══

export const GAP_LABELS: Record<string, string> = {
  diff_changed_no_test: '相关测试未变更',
  log_only_no_diff: '仅提交记录，无工作区变更',
  diff_only_no_log: '工作区有变更，缺少提交记录',
  evidence_not_found: '未找到 diff/log/test 证据',
  test_unchanged: '测试文件未变更',
  baseline_missing_file: '基线缺少文件路径',
};

export interface FixSignals {
  diff: boolean;
  log: boolean;
  test: boolean;
}

export interface FixBaselineItem {
  title: string;
  /** 对应 session.findings 中的 finding.id，跨轮追踪同一条问题 */
  findingId?: string;
  source: 'last_agent_result' | 'session' | 'git';
  evidence?: string;
  /** 映射到的关键词（用于文件搜索） */
  keywords?: string[];
}

export interface VerifiedFix {
  title: string;
  /** 对应 baseline 中的 findingId，跨轮追踪 */
  findingId?: string;
  status: 'fixed' | 'partial' | 'unresolved' | 'unknown' | 'new_risk';
  evidence: string[];
  reason: string;
  /** 证据强度 */
  evidenceLevel: 'weak' | 'medium' | 'strong';
  /** 命中的证据信号 */
  fixSignals: FixSignals;
  /** 缺口原因（partial/unresolved 时提供） */
  gapReason?: 'diff_changed_no_test' | 'log_only_no_diff' | 'baseline_missing_file' | 'evidence_not_found' | 'test_unchanged';
}

export interface FixVerificationResult {
  success: boolean;
  fixed: VerifiedFix[];
  partial: VerifiedFix[];
  unresolved: VerifiedFix[];
  unknown: VerifiedFix[];
  newRisks: VerifiedFix[];
  summary: string;
}

// ═══ Main ═══

/**
 * 修复完成度复核
 * 输入: 任务描述 + 历史问题清单(可选) + 最近 git 变更
 * 输出: 四类结果
 */
export function runFixVerification(
  baselineItems: FixBaselineItem[],
  gitDiffContent: string,
  gitLogContent: string,
): FixVerificationResult {
  const results: VerifiedFix[] = [];

  if (baselineItems.length === 0) {
    return {
      success: false,
      fixed: [], partial: [], unresolved: [], newRisks: [],
      unknown: [{
        title: '无法确认已修复项',
        status: 'unknown',
        evidenceLevel: 'weak',
        fixSignals: { diff: false, log: false, test: false },
        evidence: [],
        reason: '没有历史问题清单。请提供之前审查报告中的发现列表，或指定会话 ID 以获取基线。',
      }],
      summary: '无基线数据，无法进行修复对比。',
    };
  }

  for (const item of baselineItems) {
    const result = verifySingleFix(item, gitDiffContent, gitLogContent);
    results.push(result);
  }

  const fixed = results.filter(r => r.status === 'fixed');
  const partial = results.filter(r => r.status === 'partial');
  const unresolved = results.filter(r => r.status === 'unresolved');
  const unknown = results.filter(r => r.status === 'unknown');

  const summary = [
    fixed.length > 0 ? `✅ 已修复: ${fixed.map(f => f.title).join(', ')}` : '',
    partial.length > 0 ? `⚠️ 部分修复: ${partial.map(f => f.title).join(', ')}` : '',
    unresolved.length > 0 ? `❌ 仍未修复: ${unresolved.map(f => f.title).join(', ')}` : '',
    unknown.length > 0 ? `❓ 无法确认: ${unknown.map(f => f.title).join(', ')}` : '',
  ].filter(Boolean).join('\n') || '无历史问题清单，无法进行修复对比。';

  return {
    success: true,
    fixed, partial, unresolved, unknown,
    newRisks: [],
    summary,
  };
}

// ═══ Internal ═══

function verifySingleFix(
  item: FixBaselineItem,
  gitDiff: string,
  gitLog: string,
): VerifiedFix {
  const kw = (item.keywords || []).join('|').toLowerCase();
  const titleLower = item.title.toLowerCase();

  const diffHasChange = kw
    ? new RegExp(kw, 'i').test(gitDiff)
    : gitDiff.toLowerCase().includes(titleLower) || diffContainsKeyword(gitDiff, item.title);

  const logHasFix = gitLog.toLowerCase().includes(titleLower.slice(0, 20)) ||
    /fix|修复|security|SSRF|漏洞|补丁/i.test(gitLog);

  // 测试文件是否有变更（关联判定：文件名/目录/keyword 匹配）
  const testChanged = isRelatedTestChange(gitDiff, item);

  const signals: FixSignals = { diff: diffHasChange, log: logHasFix, test: testChanged };

  const evidenceLevel: 'weak' | 'medium' | 'strong' =
    signals.diff && signals.log && signals.test ? 'strong' :
    signals.diff && signals.log ? 'medium' :
    signals.diff || signals.log ? 'weak' : 'weak';

  // 状态判定
  if (diffHasChange && logHasFix && testChanged) {
    // strong: diff + log + test 都命中
    return {
      title: item.title, findingId: item.findingId,
      status: 'fixed', evidenceLevel: 'strong', fixSignals: signals,
      evidence: ['git diff 包含相关改动', 'git log 中有修复提交', '相关测试文件有变更'],
      reason: 'diff+log+test 三重证据确认修复已落地。',
    };
  }

  if (diffHasChange && logHasFix) {
    // medium: diff+log 命中，但缺测试
    return {
      title: item.title, findingId: item.findingId,
      status: 'fixed', evidenceLevel: 'medium', fixSignals: signals,
      gapReason: 'diff_changed_no_test',
      evidence: ['git diff 包含相关改动', 'git log 中有修复提交'],
      reason: 'diff 和 log 均有证据，但缺少相关测试变更。建议确认测试覆盖。',
    };
  }

  if (diffHasChange) {
    return {
      title: item.title, findingId: item.findingId,
      status: 'partial', evidenceLevel: 'weak', fixSignals: signals,
      gapReason: 'diff_changed_no_test',
      evidence: ['git diff 包含相关改动'],
      reason: 'diff 有变更但无对应提交记录和测试。用 git_show 确认是否为本次修复。',
    };
  }

  if (logHasFix) {
    return {
      title: item.title, findingId: item.findingId,
      status: 'partial', evidenceLevel: 'weak', fixSignals: signals,
      gapReason: 'log_only_no_diff',
      evidence: ['git log 中有相关提交'],
      reason: '提交历史中有修复，但当前工作区无对应改动（已提交）。用 git_show 确认提交内容。',
    };
  }

  return {
    title: item.title, findingId: item.findingId,
    status: 'unknown', evidenceLevel: 'weak', fixSignals: { diff: false, log: false, test: false },
    gapReason: 'evidence_not_found',
    evidence: [],
    reason: '未找到修复证据。建议提供更具体的关键词或提交范围。',
  };
}

/** 判断 diff 中的测试文件变更是否与当前 finding 相关 */
function isRelatedTestChange(diff: string, item: FixBaselineItem): boolean {
  // 提取 finding 文件名（去掉路径和扩展名）
  const fileBase = (item.keywords || [])
    .find(k => k.includes('.ts') || k.includes('.js'))
    ?.replace(/.*\//, '').replace(/\.(ts|tsx|js)$/, '') || '';
  const titleWords = item.title.toLowerCase().split(/[\s,，、]+/).filter(w => w.length > 3);

  // 在 diff 中搜索测试文件
  const testFiles = [...diff.matchAll(/^\+{3} b\/(.+?\.(?:test|spec)\.(?:ts|tsx|js))/gm)];
  for (const m of testFiles) {
    const testPath = m[1].toLowerCase();
    // 文件名匹配: web-search.ts → web-search.test.ts
    if (fileBase && testPath.includes(fileBase.toLowerCase())) return true;
    // 目录匹配: same __tests__ directory
    if (fileBase && testPath.includes('__tests__')) return true;
    // keyword 匹配: title 或 category 关键词出现在测试路径或内容中
    if (titleWords.some(w => testPath.includes(w))) return true;
  }

  // 如果没有命名测试文件，检查 diff 内容中是否引用了相关符号
  if (fileBase && new RegExp(fileBase, 'i').test(diff)) return true;

  return false;
}

function diffContainsKeyword(diff: string, title: string): boolean {
  const words = title.split(/[\s,，、]+/).filter(w => w.length > 2);
  return words.some(w => diff.toLowerCase().includes(w.toLowerCase()));
}

// ═══ Baseline Extraction ═══

/**
 * 从最近 session 中提取历史问题清单
 */
export function extractBaselineFromSession(session: Session): FixBaselineItem[] {
  const items: FixBaselineItem[] = [];

  // 优先: 从 session.findings 读取结构化数据
  if (session.findings && session.findings.length > 0) {
    for (const f of session.findings) {
      items.push({
        title: f.title,
        findingId: f.id,
        source: 'session',
        keywords: [f.file || '', f.category || '', f.title].filter(Boolean),
      });
    }
    return items;
  }

  // 降级: 从 final 文本正则提取
  if (session.steps) {
    for (const step of session.steps) {
      if (step.type === 'final' && step.content) {
        // 从最终输出中提取发现标题
        const titles = step.content.match(/(?:发现|问题|风险|🔴|🟡|🟢|⚪)\s*\d*[:：]\s*(.+)/g);
        if (titles) {
          for (const t of titles.slice(0, 10)) {
            items.push({
              title: t.replace(/^(发现|问题|风险|🔴|🟡|🟢|⚪)\s*\d*[:：]\s*/, '').slice(0, 100),
              source: 'session',
              keywords: t.split(/[\s,，、]+/).filter(w => w.length > 2),
            });
          }
        }
      }
    }
  }

  // 从 summary 提取
  if (session.summary && items.length === 0) {
    items.push({
      title: session.summary.slice(0, 100),
      source: 'session',
    });
  }

  return items;
}

// ═══ Structured Finding Extraction ═══

/**
 * 合并新 findings 到 session（去重 + 保留最高置信度）。
 * 唯一入口——所有新增 finding 必须通过此函数。
 */
export function mergeFindings(
  existing: import('deepseek-code-shared').StructuredFinding[] | undefined,
  incoming: import('deepseek-code-shared').StructuredFinding[],
): import('deepseek-code-shared').StructuredFinding[] {
  const map = new Map<string, import('deepseek-code-shared').StructuredFinding>();

  // 先加载已有 findings
  if (existing) {
    for (const f of existing) {
      const existing_f = map.get(f.id);
      if (!existing_f || f.confidence > existing_f.confidence) {
        map.set(f.id, { ...f });
      }
    }
  }

  // 合并新 findings（同 id 保留更高置信度）
  for (const f of incoming) {
    const existing_f = map.get(f.id);
    if (!existing_f) {
      map.set(f.id, { ...f });
    } else if (f.confidence > existing_f.confidence) {
      map.set(f.id, { ...f, confidence: f.confidence, evidence: f.evidence || existing_f.evidence });
    }
  }

  return [...map.values()];
}

/**
 * 从结构化报告中提取 Finding[]。
 * 匹配格式: [文件:行号] 问题 → 风险 → 验证 → 建议
 */
export function extractFindingsFromReport(
  reportText: string,
  suite: string,
): import('deepseek-code-shared').StructuredFinding[] {
  const findings: import('deepseek-code-shared').StructuredFinding[] = [];
  // 去掉代码块内容，避免把示例代码当 finding
  const cleanText = reportText.replace(/```[\s\S]*?```/g, '');
  // 匹配: [path/to/file.ts:123] 描述
  const pattern = /\[([a-zA-Z0-9_/.-]+\.(?:ts|tsx|js|json|yml|yaml|md)):(\d+)\]\s*(.+?)(?=\n\[|\n\n|$)/g;
  let match, idx = 0;

  while ((match = pattern.exec(cleanText)) !== null && idx < 20) {
    const file = match[1];
    const line = parseInt(match[2], 10);
    const description = match[3].slice(0, 200).trim();

    // Markdown 链接跳过: [text](url) 格式
    if (description.startsWith('](')) continue;

    // 推断 severity
    let severity: 'high' | 'medium' | 'low' = 'medium';
    if (/P0|崩溃|安全|漏洞|密钥|crash|security/i.test(description)) severity = 'high';
    else if (/P3|风格|规范|命名|comment/i.test(description)) severity = 'low';

    // 置信度基于证据质量（非模型自评）
    const hasRealEvidence = description.length > 30;
    const hasLineNumber = line > 0;
    const hasFile = file.length > 3;
    const confidence = hasFile && hasLineNumber && hasRealEvidence ? 0.8
      : hasFile && hasLineNumber ? 0.65
      : 0.4;

    // 稳定 ID: hash(file+line+title前40字)
    const idSource = `${file}:${line}:${description.slice(0, 40)}`;
    const id = `${suite}_${hashStr(idSource)}`;

    findings.push({
      id,
      severity,
      title: description.slice(0, 120),
      file,
      line,
      evidence: description.slice(0, 300),
      confidence,
      source: 'model',
    });
    idx++;
  }

  return findings;
}

/** 简单字符串哈希 (djb2) */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

/**
 * 判断是否为修复完成度复核任务
 */
export function isFixVerificationTask(task: string): boolean {
  return /哪些.*已.*修复|列出.*已.*修复|修复.*完成度|检查.*是否.*修复|对比.*之前|审查对比|已修复项|已.*改了什么|已经修复了吗|再检查一次|修复了吗|修好了吗/i.test(task);
}

// ═══ Orchestration ═══

export interface FixVerificationFlowResult {
  /** 注入到 messages 的系统提示 */
  systemMessage?: { role: 'system'; content: string };
  /** 结构化复核结果（用于后续 summary 覆盖） */
  fvResult: FixVerificationResult;
  /** 趋势对比行 */
  trendLines: string[];
}

/**
 * 修复完成度复核全流程——收敛所有 orchestration 逻辑
 * loop.ts 只需调用此函数并注入结果
 */
export async function runFixVerificationFlow(options: {
  session: Session;
  workingDir: string;
  taskDescription: string;
  memory?: { listSessions(): Promise<{ id: string }[]>; loadSession(id: string): Promise<Session | null> };
}): Promise<FixVerificationFlowResult | null> {
  const { session, workingDir, taskDescription, memory } = options;
  if (!isFixVerificationTask(taskDescription)) return null;

  // 1. 基线提取: 当前 session → 最近 5 个 session
  let baseline = extractBaselineFromSession(session);
  if (baseline.length === 0 && memory) {
    try {
      const sessions = await memory.listSessions();
      for (const s of sessions.slice(0, 5)) {
        const full = await memory.loadSession(s.id);
        if (full) {
          const bl = extractBaselineFromSession(full);
          if (bl.length > 0) { baseline = bl; break; }
        }
      }
    } catch { /* non-critical */ }
  }

  // 2. Git 证据获取
  let gitDiff = '', gitLog = '';
  try {
    const { execa } = await import('execa');
    gitDiff = ((await execa('git', ['diff'], { cwd: workingDir, timeout: 10_000, reject: false })).stdout || '').slice(0, 20_000);
    gitLog = ((await execa('git', ['log', '--oneline', '-10'], { cwd: workingDir, timeout: 10_000, reject: false })).stdout || '');
  } catch { /* git unavailable */ }

  // 3. 执行复核
  const fvResult = runFixVerification(baseline, gitDiff, gitLog);

  // 4. 趋势对比: 从最近 session 查找上轮结果
  const trendLines: string[] = [];
  if (memory) {
    try {
      const sessions = await memory.listSessions();
      for (const s of sessions.slice(1, 5)) {
        const prev = await memory.loadSession(s.id);
        const prevFV = prev?.__fvResult as FixVerificationResult | undefined;
        if (!prevFV || (prevFV.fixed.length === 0 && prevFV.partial.length === 0)) continue;

        const prevMap = new Map<string, VerifiedFix>();
        for (const r of [...prevFV.fixed, ...prevFV.partial, ...prevFV.unresolved, ...prevFV.unknown]) {
          if (r.findingId) prevMap.set(r.findingId, r);
        }
        const allCur = [...fvResult.fixed, ...fvResult.partial, ...fvResult.unresolved, ...fvResult.unknown];
        const changes: Array<{ text: string; dir: 'improved' | 'regressed' }> = [];
        for (const cur of allCur) {
          if (!cur.findingId) continue;
          const pr = prevMap.get(cur.findingId);
          if (!pr || (pr.status === cur.status && pr.evidenceLevel === cur.evidenceLevel)) continue;
          const statusArrow = `${pr.status}→${cur.status}`;
          const levelChange = pr.evidenceLevel !== cur.evidenceLevel ? ` [${pr.evidenceLevel}→${cur.evidenceLevel}]` : '';
          const dir = (cur.status === 'fixed' && pr.status !== 'fixed') || (cur.evidenceLevel === 'strong' && pr.evidenceLevel !== 'strong') ? 'improved'
            : (pr.status === 'fixed' && cur.status !== 'fixed') || (pr.evidenceLevel === 'strong' && cur.evidenceLevel !== 'strong') ? 'regressed'
            : 'improved'; // unchanged already filtered above
          changes.push({ text: `  - ${cur.title}: ${statusArrow}${levelChange}`, dir });
        }
        if (changes.length > 0) {
          const improved = changes.filter(c => c.dir === 'improved');
          const regressed = changes.filter(c => c.dir === 'regressed');
          trendLines.push(`📈 相比上轮 (session ${s.id.slice(0, 12)}):`);
          for (const c of [...improved, ...regressed]) {
            trendLines.push(`${c.dir === 'improved' ? '📈' : '📉'}${c.text}`);
          }
          trendLines.push('');
        }
        break;
      }
    } catch { /* trend non-critical */ }
  }

  // 5. 构建 system message
  let fvText = '## 修复完成度复核（自动对比）\n\n';
  if (fvResult.fixed.length > 0) fvText += `✅ 已修复(${fvResult.fixed.length}): ${fvResult.fixed.map(f => f.title).join('; ')}\n`;
  if (fvResult.partial.length > 0) fvText += `⚠️ 部分修复(${fvResult.partial.length}): ${fvResult.partial.map(f => f.title).join('; ')}\n`;
  if (fvResult.unresolved.length > 0) fvText += `❌ 未修复(${fvResult.unresolved.length}): ${fvResult.unresolved.map(f => f.title).join('; ')}\n`;
  if (fvResult.unknown.length > 0) fvText += `❓ 无法确认(${fvResult.unknown.length}): ${fvResult.unknown.map(f => f.title).join('; ')}\n`;
  if (gitDiff) fvText += `\ngit_diff: 有变更 (${gitDiff.length} 字符)`;
  if (gitLog) fvText += `\ngit_log: ${gitLog.split('\n').filter(Boolean).length} 条提交`;

  return {
    fvResult,
    trendLines,
    systemMessage: {
      role: 'system',
      content: `这是修复完成度复核任务。以下数据来自程序自动对比（非模型推测）：\n${fvText}\n\n请基于以上数据验证并补充细节，输出格式:\n✅ 已确认修复: [问题] — 证据: [文件/提交]\n⚠️ 部分修复: [问题] — 缺了什么\n❌ 仍未修复: [问题]\n❓ 无法确认: [问题] — 缺少什么信息`,
    },
  };
}

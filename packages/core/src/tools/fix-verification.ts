// ============================================================
// Fix Verification Pipeline — "哪些已经修复了" 专用
// 最小版: session findings + git diff → fixed/partial/unknown
// ============================================================

import type { Session } from 'deepseek-code-shared';

export interface FixBaselineItem {
  title: string;
  source: 'last_agent_result' | 'session' | 'git';
  evidence?: string;
  /** 映射到的关键词（用于文件搜索） */
  keywords?: string[];
}

export interface VerifiedFix {
  title: string;
  status: 'fixed' | 'partial' | 'unresolved' | 'unknown' | 'new_risk';
  evidence: string[];
  reason: string;
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

  // 在 diff 中搜索相关改动
  const diffHasChange = kw
    ? new RegExp(kw, 'i').test(gitDiff)
    : gitDiff.toLowerCase().includes(titleLower) || diffContainsKeyword(gitDiff, item.title);

  // 在 log 中搜索相关提交
  const logHasFix = gitLog.toLowerCase().includes(titleLower.slice(0, 20));

  if (diffHasChange && logHasFix) {
    // diff + log 都有证据 → 高度确信已修复
    return {
      title: item.title,
      status: 'fixed',
      evidence: ['git diff 包含相关改动', 'git log 中有相关提交'],
      reason: 'git diff 和 git log 中均发现相关变更证据，修复已落地。',
    };
  }

  if (diffHasChange) {
    return {
      title: item.title,
      status: 'partial',
      evidence: ['git diff 包含相关改动'],
      reason: 'diff 中有相关变更，用 git_show 查看提交内容可确认是否完全修复。',
    };
  }

  if (logHasFix) {
    return {
      title: item.title,
      status: 'partial',
      evidence: ['git log 中有相关提交'],
      reason: '提交历史中有相关修复，当前工作区无对应改动（可能已提交）。用 git_show 确认。',
    };
  }

  return {
    title: item.title,
    status: 'unknown',
    evidence: [],
    reason: '在 git diff 和 git log 中均未找到相关证据。可能已提交并合并、或未修复、或关键词不匹配。',
  };
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

  // 从 lastAgentResult.findings 提取
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

/**
 * 判断是否为修复完成度复核任务
 */
export function isFixVerificationTask(task: string): boolean {
  return /哪些.*已.*修复|列出.*已.*修复|修复.*完成度|检查.*是否.*修复|对比.*之前|审查对比|已修复项|已.*改了什么|已经修复了吗|再检查一次|修复了吗|修好了吗/i.test(task);
}

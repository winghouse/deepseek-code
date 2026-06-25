// ============================================================
// Report Validator — 报告锚点校验（纯函数，可测试）
// 规则: 假路径 → fake_paths / 无行号 → missing_locations / 无引用 → no_file_refs / findings不匹配 → unmatched_findings
// ============================================================

/** 报告引用与 findings 不匹配率阈值：超过此比例触发重写 */
export const UNMATCHED_FINDING_REF_THRESHOLD = 0.3;
/** 行号匹配容差 */
export const LINE_MATCH_TOLERANCE = 3;

export interface ReportValidationResult {
  valid: boolean;
  reason?: 'fake_paths' | 'missing_locations' | 'no_file_refs' | 'unmatched_findings';
  fakePaths: string[];
  citedFiles: string[];
  citedWithLineCount: number;
  knownFiles: string[];
  /** 报告中有但 findings 中不存在的引用 */
  unmatchedRefs?: string[];
}

/**
 * 校验报告是否引用了真实已读文件，并标注了行号。
 * 纯函数，不碰模型/IO。
 */
export function validateReportAnchors(
  content: string,
  knownFiles: string[],
  options?: { allowShortAnswer?: boolean; findings?: Array<{ file?: string; line?: number }> },
): ReportValidationResult {
  // 短回答放行
  if (options?.allowShortAnswer && content.length < 200) {
    return { valid: true, fakePaths: [], citedFiles: [], citedWithLineCount: 0, knownFiles };
  }

  // 提取文件引用 (支持英文 `file:123` 和中文 `文件 第123行`)
  const refPattern = /([a-zA-Z0-9_/.-]+\.(?:ts|tsx|js|json|yml|yaml|md))(?::(\d+)|(?:\s*第\s*(\d+)\s*行))?/g;
  const refs = [...content.matchAll(refPattern)];
  const citedFiles = refs.map(r => r[1]);
  const citedWithLineCount = refs.filter(r => r[2] || r[3]).length;

  // 标准化已知文件路径
  const normalizedKnown = knownFiles.map(f => f.replace(/\\/g, '/').replace(/^\.\//, ''));

  // 假路径检测: 文件名不在已知列表中
  const fakePaths = citedFiles.filter(cited => {
    const n = cited.replace(/\\/g, '/').replace(/^\.\//, '');
    return !normalizedKnown.some(k => matchesPath(n, k));
  });

  if (fakePaths.length > 0) {
    return { valid: false, reason: 'fake_paths', fakePaths: [...new Set(fakePaths)], citedFiles, citedWithLineCount, knownFiles };
  }

  // 联动 findings: 报告中的 [file:line] 必须能映射到 session.findings
  if (options?.findings && options.findings.length > 0 && citedWithLineCount > 0) {
    const unmatched: string[] = [];
    for (const ref of refs) {
      const lineText = ref[2] || ref[3]; // 英文 file:123 或 中文 第123行
      if (!lineText) continue;
      const refFile = ref[1].replace(/\\/g, '/').replace(/^\.\//, '');
      const refLine = parseInt(lineText, 10);
      const matched = options.findings.some(f => {
        if (!f.file || !f.line) return false;
        return matchesPath(refFile, f.file.replace(/\\/g, '/')) && Math.abs(f.line - refLine) <= LINE_MATCH_TOLERANCE;
      });
      if (!matched) unmatched.push(`${refFile}:${refLine}`);
    }
    if (unmatched.length > 0 && unmatched.length > citedWithLineCount * UNMATCHED_FINDING_REF_THRESHOLD) {
      return { valid: false, reason: 'unmatched_findings', fakePaths: [], citedFiles, citedWithLineCount, unmatchedRefs: unmatched.slice(0, 5), knownFiles };
    }
  }

  if (citedFiles.length === 0) {
    return { valid: false, reason: 'no_file_refs', fakePaths: [], citedFiles, citedWithLineCount, knownFiles };
  }

  if (citedWithLineCount === 0) {
    return { valid: false, reason: 'missing_locations', fakePaths: [], citedFiles, citedWithLineCount, knownFiles };
  }

  return { valid: true, fakePaths: [], citedFiles, citedWithLineCount, knownFiles };
}

/**
 * 根据校验结果生成重试提示
 */
export function buildRetryPrompt(v: ReportValidationResult): string {
  const realList = v.knownFiles.slice(0, 8).join(', ');

  switch (v.reason) {
    case 'fake_paths':
      return `你引用了不存在或未读取的文件: ${v.fakePaths.slice(0, 5).join(', ')}。你实际读过的文件: ${realList}。请只用这些文件重新输出，每条写 [文件:行号]。无法确定行号的发现不要输出。`;
    case 'missing_locations':
      return `你的报告引用了文件但没有行号。请重新输出，每条必须写 [文件:行号]。无法确定行号的发现不要输出。读过的文件: ${realList}。`;
    case 'no_file_refs':
      return `你的报告没有引用任何已读文件。你实际读过的文件: ${realList}。请基于这些文件重新输出；如果没有可验证发现，直接说"未发现可验证的问题"。`;
    case 'unmatched_findings':
      return `你的报告引用了不在结构化发现列表中的位置: ${(v.unmatchedRefs || []).slice(0, 5).join(', ')}。请只输出已验证的发现，不要新增或改写发现。`;
    default:
      return `请重新输出，每条发现写 [文件:行号]。读过的文件: ${realList}。`;
  }
}

/**
 * 生成降级报告（两次重试仍不合格时使用）
 * 包含已读文件清单 + 建议缩小范围重试
 */
export function buildDegradedReport(knownFiles: string[], summary?: string): string {
  const lines = [
    '## 详细分析未能生成',
    '',
    '原因：模型输出缺少真实文件:行号引用，已校验收敛至降级报告。',
    `已读取文件：${knownFiles.slice(0, 10).join(', ')}${knownFiles.length > 10 ? ` 等${knownFiles.length}个` : ''}。`,
  ];
  if (summary) {
    lines.push('', '### 核心发现（来自摘要阶段）', '', summary);
  }
  lines.push('', '💡 建议：用更具体的任务描述重试（如"检查 web-search.ts 的 catch 块"而非"审查对比"），或逐文件提问获取精确定位。');
  return lines.join('\n');
}

/**
 * 短路径匹配: router.ts 能匹配 packages/core/src/agent/router.ts
 */
function matchesPath(cited: string, known: string): boolean {
  if (cited === known) return true;
  if (known.endsWith('/' + cited)) return true;
  if (known.endsWith(cited)) return true;
  return false;
}

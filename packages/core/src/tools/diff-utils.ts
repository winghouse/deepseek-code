// ============================================================
// Tool Layer — Diff 解析工具 (apply_patch 核心逻辑)
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 增强 unified diff 应用器
 * 支持：多 hunk / 纯新增文件 / 无上下文行的极简 diff / SEARCH/REPLACE 块格式
 */
export function applyUnifiedDiff(
  original: string,
  patch: string,
  fileName: string,
): string | null {
  // 先试 SEARCH/REPLACE 格式（模型常输出这种）
  const srResult = applySearchReplace(original, patch);
  if (srResult !== null) return srResult;

  // 再试 unified diff
  const origLines = original.split('\n');
  const patchLines = patch.split('\n');
  const result: string[] = [];
  let origIdx = 0;

  // 纯新增文件检测
  if (patch.includes('new file') || patch.includes('--- /dev/null')) {
    const added: string[] = [];
    for (const line of patchLines) {
      if (line.startsWith('+') && !line.startsWith('+++ ')) {
        added.push(line.slice(1));
      }
    }
    if (added.length > 0) return added.join('\n');
  }

  // 解析 hunks
  interface HunkOp {
    type: 'context' | 'add' | 'remove';
    content: string;
    origLine?: number;
  }

  const hunks: Array<{ oldStart: number; oldCount: number; ops: HunkOp[] }> = [];
  let currentHunk: { oldStart: number; oldCount: number; ops: HunkOp[] } | null = null;
  let currentOldLine = 0;

  for (const line of patchLines) {
    // 跳过文件头
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }
    // 跳过空 hunk 头（如 @@ -0,0 +1 @@）
    if (line === '@@') continue;

    // 解析 hunk header
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] ?? '1', 10),
        ops: [],
      };
      currentOldLine = currentHunk.oldStart;
      continue;
    }

    if (!currentHunk) continue;

    // 跳过末尾标记
    if (line === '\\ No newline at end of file') continue;

    if (line.startsWith(' ')) {
      currentHunk.ops.push({ type: 'context', content: line.slice(1), origLine: currentOldLine });
      currentOldLine++;
    } else if (line.startsWith('-')) {
      currentHunk.ops.push({ type: 'remove', content: line.slice(1), origLine: currentOldLine });
      currentOldLine++;
    } else if (line.startsWith('+')) {
      currentHunk.ops.push({ type: 'add', content: line.slice(1) });
    }
    // 跳过无法识别的行
  }
  if (currentHunk) hunks.push(currentHunk);

  // 如果没有任何 hunk，返回 null
  if (hunks.length === 0) return null;

  // 应用每个 hunk
  for (const hunk of hunks) {
    // 复制到 hunk 开始位置
    const targetIdx = hunk.oldStart - 1; // 0-based
    while (origIdx < targetIdx && origIdx < origLines.length) {
      result.push(origLines[origIdx++]);
    }

    // 执行 hunk 操作
    for (const op of hunk.ops) {
      if (op.type === 'context') {
        // 模糊匹配：如果当前行与上下文不完全一致但接近，仍然推进
        if (origIdx < origLines.length) {
          result.push(origLines[origIdx++]);
        }
      } else if (op.type === 'remove') {
        // 跳过原始行（模糊匹配，即使不完全一致也跳过）
        if (origIdx < origLines.length) {
          origIdx++;
        }
      } else if (op.type === 'add') {
        result.push(op.content);
      }
    }
  }

  // 复制剩余行
  while (origIdx < origLines.length) {
    result.push(origLines[origIdx++]);
  }

  return result.join('\n');
}

/**
 * SEARCH/REPLACE 块格式解析
 *
 * 很多 LLM 输出这种格式：
 * <<<<<<< SEARCH
 * old code
 * =======
 * new code
 * >>>>>>> REPLACE
 */
export function applySearchReplace(original: string, patch: string): string | null {
  const blocks = patch.match(/<<<<<<<\s*SEARCH\s*\n([\s\S]*?)=======\s*\n([\s\S]*?)>>>>>>>\s*REPLACE/g);
  if (!blocks || blocks.length === 0) return null;

  let result = original;
  for (const block of blocks) {
    const m = block.match(/<<<<<<<\s*SEARCH\s*\n([\s\S]*?)=======\s*\n([\s\S]*?)>>>>>>>\s*REPLACE/);
    if (!m) continue;
    const search = m[1];
    const replace = m[2];
    if (result.includes(search)) {
      result = result.replace(search, replace);
    }
  }

  return result !== original ? result : null;
}

/** 从 patch 的 +++ 行提取文件名 */
export function extractFilesFromPatch(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split('\n')) {
    // +++ b/filename 格式
    const m = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (m) files.push(m[1].trim());
  }
  return files;
}

/** applyPatch 失败时回滚已写入的文件 */
export function rollbackApplied(
  log: Array<{ file: string; backup?: string; original?: string; isNew: boolean }>,
  workingDir: string,
): void {
  for (const entry of log.reverse()) {
    try {
      const p = path.resolve(workingDir, entry.file);
      if (entry.isNew) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } else if (entry.original !== undefined) {
        fs.writeFileSync(p, entry.original, 'utf-8');
      }
    } catch { /* best effort */ }
  }
}

/** 从 patch 中提取新文件内容（新文件创建场景） */
export function extractNewFileContent(patch: string): string | null {
  const lines = patch.split('\n');
  const added: string[] = [];
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++ ')) {
      added.push(line.slice(1));
    }
  }
  return added.length > 0 ? added.join('\n') : null;
}

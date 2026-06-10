// ============================================================
// Verified Audit — 确定性工具
// 程序判断优先于模型判断
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolExecutionResult, AuditFinding, AuditEvidence, AuditReport } from 'deepseek-code-shared';
import { findSymbolReferencesAST, toToolResult } from './symbol-finder.js';

export function auditTools(workingDir: string) {
  const resolve = (p: string) => path.resolve(workingDir, p);

  return {
    /** 读取 JSON 文件的指定路径 */
    readJsonPath(file: string, jsonPath: string): ToolExecutionResult {
      try {
        const fullPath = resolve(file);
        if (!fs.existsSync(fullPath)) {
          return { success: false, content: `文件不存在: ${file}`, error: 'file_not_found' };
        }
        const obj = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        const value = resolveJsonPath(obj, jsonPath);
        return {
          success: true,
          content: JSON.stringify(value),
          metadata: { file, jsonPath, type: Array.isArray(value) ? 'array' : typeof value, exists: value !== undefined },
        };
      } catch (e) {
        return { success: false, content: `JSON 路径解析失败: ${jsonPath}`, error: String(e) };
      }
    },

    /** 列出所有 scripts */
    listScripts(): ToolExecutionResult {
      try {
        const pkgPath = resolve('package.json');
        if (!fs.existsSync(pkgPath)) return { success: false, content: 'package.json 不存在' };
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const scripts = pkg.scripts ?? {};
        const keys = Object.keys(scripts);
        const details = keys.map((k) => `${k}: ${scripts[k]}`).join('\n');
        return {
          success: true,
          content: details || '(无 scripts)',
          metadata: { type: typeof scripts, count: keys.length, keys },
        };
      } catch (e) {
        return { success: false, content: '读取 scripts 失败', error: String(e) };
      }
    },

    /** 检测跨平台风险命令 */
    detectCrossPlatform(): ToolExecutionResult {
      const issues: string[] = [];
      const patterns: Array<{ pattern: RegExp; desc: string }> = [
        { pattern: /\brm\s+-rf\b/, desc: 'rm -rf 在 Windows cmd 下不可用' },
        { pattern: /\bcp\s+-r\b/, desc: 'cp -r 在 Windows cmd 下不可用' },
        { pattern: /\bmkdir\s+-p\b/, desc: 'mkdir -p 在 Windows cmd 下语义不同' },
        { pattern: /\bchmod\b/, desc: 'chmod 在 Windows 下不可用' },
        { pattern: /\bchown\b/, desc: 'chown 在 Windows 下不可用' },
        { pattern: /\bln\s+-s\b/, desc: 'ln -s 在 Windows 下不支持' },
      ];

      try {
        const pkgFiles = findFiles(workingDir, 'package.json', 3);
        for (const pkgFile of pkgFiles) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
            const scripts = pkg.scripts ?? {};
            for (const [name, cmd] of Object.entries(scripts)) {
              if (typeof cmd !== 'string') continue;
              for (const { pattern, desc } of patterns) {
                if (pattern.test(cmd)) {
                  issues.push(`${pkgFile} → ${name}: "${cmd}" — ${desc}`);
                }
              }
            }
          } catch { /* skip */ }
        }
        return {
          success: true,
          content: issues.length > 0 ? issues.join('\n') : '未检测到跨平台风险命令',
          metadata: { issueCount: issues.length, issues },
        };
      } catch (e) {
        return { success: false, content: '跨平台检测失败', error: String(e) };
      }
    },

    /** 检查文件是否存在 */
    fileExists(p: string): ToolExecutionResult {
      const exists = fs.existsSync(resolve(p));
      return {
        success: true,
        content: exists ? `✅ ${p} 存在` : `❌ ${p} 不存在`,
        metadata: { path: p, exists },
      };
    },

    /** 查找符号引用（AST 优先，文本搜索降级） */
    findReferences(symbol: string): ToolExecutionResult {
      try {
        const result = findSymbolReferencesAST(symbol, workingDir);
        return toToolResult(result);
      } catch (e) {
        return { success: false, content: '引用查找失败', error: String(e) };
      }
    },

    /** 验证一条 finding */
    verifyFinding(finding: AuditFinding): AuditFinding {
      const result = { ...finding };
      // 有 evidence 且无冲突 → verified
      if (result.evidence.length > 0) {
        // 检查 evidence 之间是否有冲突
        const conflicts = result.evidence.filter((e) =>
          e.snippet?.includes('rejected') || e.snippet?.includes('false'),
        );
        if (conflicts.length > 0) {
          result.verificationStatus = 'rejected';
          result.rejectionReason = 'Evidence 中存在冲突标记';
          result.confidence = 0;
        } else {
          result.verificationStatus = 'verified';
          result.confidence = Math.min(1, result.confidence + 0.2);
        }
      } else {
        result.verificationStatus = 'unverified';
        result.confidence = Math.max(0, result.confidence - 0.3);
      }
      return result;
    },
  };
}

/** JSON path 解析: $.scripts.clean → obj.scripts.clean */
function resolveJsonPath(obj: unknown, jsonPath: string): unknown {
  const parts = jsonPath.replace(/^\$\.?/, '').split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function findFiles(dir: string, name: string, maxDepth: number): string[] {
  const results: string[] = [];
  function walk(d: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(d, entry.name);
        if (entry.isFile() && entry.name === name) results.push(full);
        if (entry.isDirectory()) walk(full, depth + 1);
      }
    } catch { /* skip */ }
  }
  walk(dir, 0);
  return results;
}

function walkFiles(dir: string, cb: (filePath: string) => void) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile()) cb(full);
      else if (entry.isDirectory()) walkFiles(full, cb);
    }
  } catch { /* skip */ }
}

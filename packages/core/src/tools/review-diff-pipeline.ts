// ============================================================
// Review Diff Pipeline — git diff 审查
// 不扫全项目，只看 diff + 相关文件
// v2: 增强 API breaking change / 测试缺失 / 依赖变更检测
// ============================================================

import { execa } from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ═══ Types ═══

export interface DiffReviewResult {
  success: boolean;
  summary: string;
  diffSummary: string;
  changedFiles: string[];
  /** M/A/D/R — Modified, Added, Deleted, Renamed */
  fileStatuses: Record<string, 'M' | 'A' | 'D' | 'R'>;
  riskLevel: 'low' | 'medium' | 'high';
  findings: DiffFinding[];
  /** 详细统计数据 */
  stats: {
    totalFiles: number;
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    testFilesChanged: number;
    testFilesDeleted: number;
    configFilesChanged: number;
    securityFilesChanged: number;
    dependencyChanges: boolean;
    apiBreakingRisks: number;
  };
  elapsedMs: number;
}

export interface DiffFinding {
  file: string;
  lineHint?: string;
  severity: 'low' | 'medium' | 'high';
  category: 'security' | 'config' | 'test' | 'api' | 'dependency' | 'style' | 'general';
  description: string;
  suggestion?: string;
}

// ═══ Main Pipeline ═══

export async function runReviewDiffPipeline(options: {
  workingDir: string;
  against?: string;
  onProgress?: (step: string) => void;
}): Promise<DiffReviewResult> {
  const start = Date.now();
  const { workingDir, against, onProgress } = options;
  const tick = () => new Promise(r => setTimeout(r, 0));
  const findings: DiffFinding[] = [];
  const fileStatuses: Record<string, 'M' | 'A' | 'D' | 'R'> = {};

  const gitArgs = against ? [against] : [];
  const diffTarget = against ? `${against}` : '';

  onProgress?.('📋 获取 Git diff...');
  await tick();

  // ═══ Step 1: git diff --name-status ═══
  let changedFiles: string[] = [];
  try {
    const { stdout } = await execa('git', ['diff', '--name-status', ...gitArgs], {
      cwd: workingDir, timeout: 5000, reject: false,
    });
    for (const line of stdout.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      const status = parts[0]?.trim() as 'M' | 'A' | 'D' | 'R';
      const file = parts[1]?.trim() || parts[0]?.trim();
      if (status && file) {
        fileStatuses[file] = status;
        changedFiles.push(file);
      }
    }
  } catch {
    // Fallback: git diff --stat
    try {
      const { stdout } = await execa('git', ['diff', '--stat', ...gitArgs], {
        cwd: workingDir, timeout: 5000, reject: false,
      });
      for (const line of stdout.split('\n')) {
        const m = line.match(/^\s*(.+?)\s+\|\s+\d+/);
        if (m) {
          const f = m[1].trim();
          fileStatuses[f] = 'M';
          changedFiles.push(f);
        }
      }
    } catch { /* git not available */ }
  }

  // ═══ Step 2: 统计 ═══
  const stats = {
    totalFiles: changedFiles.length,
    added: 0, modified: 0, deleted: 0, renamed: 0,
    testFilesChanged: 0, testFilesDeleted: 0,
    configFilesChanged: 0, securityFilesChanged: 0,
    dependencyChanges: false, apiBreakingRisks: 0,
  };
  for (const [file, status] of Object.entries(fileStatuses)) {
    if (status === 'A') stats.added++;
    else if (status === 'D') stats.deleted++;
    else if (status === 'R') stats.renamed++;
    else stats.modified++;

    if (/\.test\.|__tests__|spec\.|\.spec\./.test(file)) {
      stats.testFilesChanged++;
      if (status === 'D') stats.testFilesDeleted++;
    }
    if (/package\.json|tsconfig|\.config\./.test(file)) stats.configFilesChanged++;
    if (/permission|auth|security|sandbox|guard|secret|token/i.test(file)) stats.securityFilesChanged++;
  }

  if (changedFiles.length === 0) {
    return {
      success: true,
      summary: '工作区干净，无改动。',
      diffSummary: '',
      changedFiles: [],
      fileStatuses: {},
      riskLevel: 'low',
      findings: [],
      stats,
      elapsedMs: Date.now() - start,
    };
  }

  // ═══ Step 3: 获取完整 diff ═══
  let fullDiff = '';
  try {
    const { stdout } = await execa('git', ['diff', ...gitArgs], {
      cwd: workingDir, timeout: 10000, reject: false,
    });
    fullDiff = stdout || '';
  } catch { /* ignore */ }

  onProgress?.(`🔬 逐文件检查 (${changedFiles.length} 个文件)...`);
  await tick();

  // ═══ Step 4: 逐文件检查 ═══

  for (const f of changedFiles) {
    const status = fileStatuses[f] ?? 'M';

    // 4a: 敏感/安全文件
    if (/\.env$|\.env\.|secret|credential|private.*key|\.pem$/i.test(f)) {
      findings.push({
        file: f, severity: 'high', category: 'security',
        description: status === 'D' ? '删除敏感文件' : '修改敏感文件，确认是否为预期改动',
        suggestion: '敏感文件变更需要人工确认',
      });
    }

    // 4b: 安全模块变更
    if (/permission|auth|security|sandbox|guard/i.test(f)) {
      findings.push({
        file: f, severity: 'high', category: 'security',
        description: '安全模块变更，建议人工复核',
        suggestion: '确认权限逻辑未被意外削弱，安全约束未被绕过',
      });
    }

    // 4c: 配置文件变更
    if (/package\.json$/.test(f)) {
      findings.push({
        file: f, severity: 'medium', category: 'dependency',
        description: 'package.json 变更，检查依赖变更',
        suggestion: '检查新增/删除/版本变更的依赖，确认无意外降级或引入不兼容版本',
      });
      stats.dependencyChanges = true;
    }
    if (/tsconfig.*\.json$/.test(f)) {
      findings.push({
        file: f, severity: 'medium', category: 'config',
        description: 'TypeScript 配置变更',
        suggestion: '确认 strict 模式、target、module 等关键编译选项未被意外修改',
      });
    }

    // 4d: 测试文件删除
    if (/\.test\.|__tests__|spec\.|\.spec\./.test(f) && status === 'D') {
      findings.push({
        file: f, severity: 'high', category: 'test',
        description: '测试文件被删除！可能导致测试覆盖率下降',
        suggestion: '确认对应功能是否已被废弃，否则应恢复测试文件',
      });
    }

    // 4e: API 接口/类型文件变更 → 可能的 breaking change
    if (/(types?|interfaces?|d\.ts|schemas?)\b/i.test(f) || f.endsWith('.d.ts')) {
      // 检查 diff 中是否删除了 export
      const fileDiff = extractFileDiff(fullDiff, f);
      if (fileDiff) {
        const removedExports = [...fileDiff.matchAll(/^-\s*(export\s+(type\s+)?(interface|type|function|class|const|enum)\s+(\w+))/gm)];
        const removedMembers = [...fileDiff.matchAll(/^-\s*(\w+\??\s*:\s*.+)/gm)];
        const changedSignatures = [...fileDiff.matchAll(/^[-+]\s*(\w+)\s*\(/gm)];

        if (removedExports.length > 0) {
          stats.apiBreakingRisks++;
          findings.push({
            file: f, severity: 'high', category: 'api',
            description: `可能删除了 ${removedExports.length} 个导出: ${removedExports.map((m) => m[4]).join(', ')}`,
            suggestion: '删除公开 API 是 breaking change，确认调用方已更新',
          });
        }
        if (changedSignatures.length >= 4 && removedExports.length === 0) {
          findings.push({
            file: f, severity: 'medium', category: 'api',
            description: `函数签名变更较多 (${Math.floor(changedSignatures.length / 2)} 处)，检查调用方兼容性`,
            suggestion: '函数签名变更是 breaking change，确认所有调用方已适配',
          });
        }
      }
    }

    // 4f: 锁定文件变更
    if (/pnpm-lock|package-lock|yarn\.lock/i.test(f)) {
      findings.push({
        file: f, severity: 'low', category: 'dependency',
        description: '依赖锁定文件变更',
        suggestion: '确认依赖变更是预期行为，运行 pnpm install 后测试通过',
      });
    }
  }

  // ═══ Step 5: diff 内容级检查 ═══

  // 5a: 危险代码模式
  if (fullDiff.includes('shell: true') || fullDiff.includes("shell:'") || fullDiff.includes('shell:"')) {
    const lineMatch = fullDiff.match(/^\+.*shell\s*:\s*(true|['"][^'"]*['"])/m);
    findings.push({
      file: '(diff)', severity: 'high', category: 'security',
      description: '检测到 shell:true，确认命令执行安全',
      suggestion: '优先使用 execa 的 shell:false 模式，避免命令注入',
      lineHint: lineMatch ? lineMatch[0].trim() : undefined,
    });
  }
  if (/^\+.*process\.env\.(?!NODE_ENV|TERM|SHELL|PATH\b)/m.test(fullDiff)) {
    findings.push({
      file: '(diff)', severity: 'medium', category: 'security',
      description: '新增 process.env 访问，确认无敏感变量泄露',
      suggestion: '确保新增的环境变量读取在 safeEnv() 白名单中',
    });
  }

  // 5b: 硬编码密钥/URL
  const secretPatterns = [
    { regex: /^\+.*['"]\s*sk-[a-zA-Z0-9]{20,}\s*['"]/, label: '疑似 API Key 硬编码' },
    { regex: /^\+.*['"]\s*https?:\/\/[^'"]*:(?!\/\/)[^'"]*@/, label: 'URL 中含认证信息' },
    { regex: /^\+.*['"]\s*ghp_[a-zA-Z0-9]{20,}\s*['"]/, label: '疑似 GitHub Token 硬编码' },
  ];
  for (const { regex, label } of secretPatterns) {
    if (regex.test(fullDiff)) {
      findings.push({
        file: '(diff)', severity: 'high', category: 'security',
        description: label,
        suggestion: '立即删除硬编码密钥，使用环境变量或密钥管理服务',
      });
    }
  }

  // 5c: 危险函数使用
  if (/^\+.*\beval\s*\(/m.test(fullDiff)) {
    findings.push({
      file: '(diff)', severity: 'high', category: 'security',
      description: '新增 eval() 调用，存在代码注入风险',
      suggestion: '避免使用 eval，考虑 JSON.parse 或 Function 的替代方案',
    });
  }
  if (/^\+.*\binnerHTML\s*=/m.test(fullDiff) || /^\+.*dangerouslySetInnerHTML/m.test(fullDiff)) {
    findings.push({
      file: '(diff)', severity: 'medium', category: 'security',
      description: '新增 innerHTML 使用，注意 XSS 风险',
      suggestion: '确保内容已经过 HTML 转义或使用 DOMPurify 清洗',
    });
  }

  // 5d: 删除测试
  if (/^-.*\b(it|test|describe)\s*\(/m.test(fullDiff)) {
    findings.push({
      file: '(diff)', severity: 'medium', category: 'test',
      description: '删除了测试用例 (it/test/describe)',
      suggestion: '确认删除的测试是否对应已废弃功能',
    });
  }

  // 5e: .only 残留
  if (/^\+.*\.only\s*\(/m.test(fullDiff)) {
    findings.push({
      file: '(diff)', severity: 'medium', category: 'test',
      description: '新增 .only() 调用，可能导致其他测试被跳过',
      suggestion: '提交前移除 .only()，确保完整测试套件运行',
    });
  }

  // ═══ Step 6: 风险评估 ═══
  const highCount = findings.filter((f) => f.severity === 'high').length;
  const mediumCount = findings.filter((f) => f.severity === 'medium').length;
  let riskLevel: DiffReviewResult['riskLevel'];
  if (highCount > 0 || stats.apiBreakingRisks > 0 || stats.testFilesDeleted > 0) {
    riskLevel = 'high';
  } else if (mediumCount > 2 || stats.configFilesChanged > 1 || stats.securityFilesChanged > 0) {
    riskLevel = 'medium';
  } else {
    riskLevel = 'low';
  }

  // ═══ Step 7: 生成摘要 ═══
  const summaryParts = [
    `${changedFiles.length} 个文件变更`,
    stats.added > 0 ? `+${stats.added}新增` : '',
    stats.modified > 0 ? `~${stats.modified}修改` : '',
    stats.deleted > 0 ? `-${stats.deleted}删除` : '',
    stats.renamed > 0 ? `→${stats.renamed}重命名` : '',
    `${findings.length} 条发现 (🔴${highCount} 🟡${mediumCount} 🟢${findings.length - highCount - mediumCount})`,
    stats.apiBreakingRisks > 0 ? `⚠️ ${stats.apiBreakingRisks} 个 API breaking 风险` : '',
    stats.testFilesDeleted > 0 ? `⚠️ ${stats.testFilesDeleted} 个测试文件被删除` : '',
  ];
  const summary = summaryParts.filter(Boolean).join(' | ');

  // 获取 diff --stat 摘要
  let diffSummary = '';
  try {
    const { stdout } = await execa('git', ['diff', '--stat', ...gitArgs], {
      cwd: workingDir, timeout: 5000, reject: false,
    });
    diffSummary = stdout?.slice(0, 500) || '';
  } catch { /* ignore */ }

  return {
    success: true,
    summary,
    diffSummary,
    changedFiles,
    fileStatuses,
    riskLevel,
    findings,
    stats,
    elapsedMs: Date.now() - start,
  };
}

/** 从完整 diff 中提取单个文件的 diff */
function extractFileDiff(fullDiff: string, file: string): string | null {
  const pattern = new RegExp(
    `diff --git a/${escapeRegex(file)} b/${escapeRegex(file)}[\\s\\S]*?(?=diff --git|$)`,
    'g',
  );
  const match = fullDiff.match(pattern);
  return match ? match[0] : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

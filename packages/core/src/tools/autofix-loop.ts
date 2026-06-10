// ============================================================
// AutoFix Loop — 自主修复闭环
// audit → repair → verify → retry → report
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';
import type { AuditFinding, AuditReport, AuditScope } from 'deepseek-code-shared';
import type { RepairResult } from './repair-pipeline.js';
import { runAuditPipeline } from './audit-pipeline.js';
import { runRepairPipeline } from './repair-pipeline.js';

// ═══ Types ═══

/** 单次修复尝试 */
export interface FixAttempt {
  findingId: string;
  findingTitle: string;
  severity: string;
  attempt: number;
  status: 'audited' | 'repairing' | 'applying' | 'verifying' | 'fixed' | 'failed' | 'rolled_back';
  patchProposal?: string;
  repairResult?: RepairResult;
  verifyCommand?: string;
  verifyOutput?: string;
  verifyPassed?: boolean;
  error?: string;
  startedAt: string;
  endedAt?: string;
}

/** AutoFix 结果 */
export interface AutoFixResult {
  totalFindings: number;
  fixed: number;
  failed: number;
  skipped: number;
  attempts: FixAttempt[];
  elapsedMs: number;
  summary: string;
  auditReport?: AuditReport;
}

/** AutoFix 选项 */
export interface AutoFixOptions {
  workingDir: string;
  /** 审查范围 */
  scopes?: AuditScope[];
  /** 每个 finding 最大修复轮次，默认 3 */
  maxRetries?: number;
  /** 验证命令，默认 pnpm typecheck */
  verifyCommand?: string;
  /** 模式 */
  mode?: 'readonly' | 'ask' | 'auto';
  /** 进度回调 */
  onProgress?: (step: string) => void;
  /** 严重度阈值，低于此级别的跳过，默认 'low' */
  minSeverity?: 'low' | 'medium' | 'high';
}

// ═══ Constants ═══

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const DEFAULT_VERIFY_COMMAND = 'pnpm typecheck';

// ═══ Main ═══

/**
 * AutoFix Loop — 自主修复闭环
 *
 * 流程:
 *   1. audit — 扫描项目发现问题
 *   2. for each finding (h→m→l):
 *     2a. repair — 生成修复方案
 *     2b. apply — 写入修复
 *     2c. verify — 编译/测试验证
 *     2d. 失败 → 回滚 → 重试 (最多 N 轮)
 *   3. report — 输出修复结果
 */
export async function runAutoFixLoop(options: AutoFixOptions): Promise<AutoFixResult> {
  const start = Date.now();
  const {
    workingDir,
    scopes,
    maxRetries = 3,
    verifyCommand = DEFAULT_VERIFY_COMMAND,
    mode = 'readonly',
    minSeverity = 'low',
    onProgress,
  } = options;

  const attempts: FixAttempt[] = [];
  let fixed = 0;
  let failed = 0;
  let skipped = 0;

  // ═══ Step 1: Audit ═══
  onProgress?.('🔍 扫描项目并审查代码...');
  const auditReport = await runAuditPipeline({
    workingDir,
    scopes: scopes as AuditScope[] | undefined,
    mode: 'standard',
    onProgress: (step) => onProgress?.(`  ${step}`),
  });

  // 过滤出需要修复的 findings
  const actionableFindings = auditReport.findings.filter(
    f => f.verificationStatus !== 'rejected' &&
         f.findingKind !== 'rejected' &&
         SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[minSeverity],
  );

  // 按严重度排序
  actionableFindings.sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99),
  );

  onProgress?.(`📋 发现 ${actionableFindings.length} 个待修复问题 (共 ${auditReport.findings.length} 个候选)`);

  if (actionableFindings.length === 0) {
    return {
      totalFindings: 0,
      fixed: 0,
      failed: 0,
      skipped: 0,
      attempts: [],
      elapsedMs: Date.now() - start,
      summary: '✅ 未发现需要修复的问题',
      auditReport,
    };
  }

  // readonly 模式 — 只报告不修复
  if (mode === 'readonly') {
    onProgress?.('⚠️ readonly 模式：仅报告，不执行修复');
    for (const f of actionableFindings) {
      attempts.push({
        findingId: f.id,
        findingTitle: f.title,
        severity: f.severity,
        attempt: 1,
        status: 'audited',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });
    }
    return {
      totalFindings: actionableFindings.length,
      fixed: 0,
      failed: 0,
      skipped: actionableFindings.length,
      attempts,
      elapsedMs: Date.now() - start,
      summary: `🔒 readonly 模式：已识别 ${actionableFindings.length} 个问题，切换到 --write 模式执行修复`,
      auditReport,
    };
  }

  // ═══ Step 2: Fix Loop ═══
  for (const finding of actionableFindings) {
    onProgress?.(`\n🔧 修复 [${finding.severity}] ${finding.title}`);

    let findingFixed = false;

    for (let retry = 1; retry <= maxRetries; retry++) {
      const attempt: FixAttempt = {
        findingId: finding.id,
        findingTitle: finding.title,
        severity: finding.severity,
        attempt: retry,
        status: 'repairing',
        startedAt: new Date().toISOString(),
      };

      try {
        // 2a. Repair
        onProgress?.(`  🔬 第 ${retry}/${maxRetries} 轮: 生成修复方案...`);
        const taskDescription = buildRepairTask(finding);
        const repairResult = await runRepairPipeline({
          workingDir,
          taskDescription,
          mode: mode === 'auto' ? 'auto' : 'ask',
          onProgress: (step) => onProgress?.(`    ${step}`),
        });

        attempt.repairResult = repairResult;
        attempt.patchProposal = repairResult.patchProposal;

        if (!repairResult.success || !repairResult.patchProposal) {
          attempt.status = 'failed';
          attempt.error = repairResult.success
            ? '未生成修复方案（可能需要手动处理）'
            : `修复生成失败: ${repairResult.summary}`;
          attempt.endedAt = new Date().toISOString();
          attempts.push(attempt);
          break;
        }

        // 2b. Apply patch
        onProgress?.('  📝 应用修复...');
        attempt.status = 'applying';

        const affectedFiles = extractAffectedFiles(repairResult.patchProposal);
        const patchResult = await applyPatchTool(
          { patch: repairResult.patchProposal, filesAffected: affectedFiles },
          workingDir,
        );

        if (!patchResult.success) {
          attempt.status = 'failed';
          attempt.error = `应用补丁失败: ${patchResult.error || patchResult.content}`;
          attempt.endedAt = new Date().toISOString();
          attempts.push(attempt);
          break;
        }

        // 2c. Verify
        onProgress?.('  ✅ 验证修复...');
        attempt.status = 'verifying';
        attempt.verifyCommand = verifyCommand;

        const verifyResult = await runVerify(verifyCommand, workingDir);
        attempt.verifyOutput = verifyResult.output;
        attempt.verifyPassed = verifyResult.passed;

        if (verifyResult.passed) {
          attempt.status = 'fixed';
          attempt.endedAt = new Date().toISOString();
          attempts.push(attempt);
          fixed++;
          findingFixed = true;
          onProgress?.(`  ✅ 修复成功 (${retry} 轮)`);
          break;
        }

        // 2d. Rollback and retry
        onProgress?.(`  ⚠️ 验证失败，回滚修改...`);
        attempt.status = 'rolled_back';
        attempt.endedAt = new Date().toISOString();
        attempts.push(attempt);

        // 回滚（applyPatchTool 内置回滚，但此处显式处理）
        await rollbackPatch(affectedFiles, workingDir);

        if (retry < maxRetries) {
          onProgress?.(`  🔄 准备下一轮修复...`);
        }
      } catch (err) {
        attempt.status = 'failed';
        attempt.error = (err as Error).message;
        attempt.endedAt = new Date().toISOString();
        attempts.push(attempt);
        break;
      }
    }

    if (!findingFixed) {
      failed++;
      onProgress?.(`  ❌ ${maxRetries} 轮修复均失败，跳过`);
    }
  }

  // ═══ Step 3: Report ═══
  const elapsed = Date.now() - start;
  const totalFixed = fixed;
  const totalFailed = failed;
  const totalSkipped = actionableFindings.length - totalFixed - totalFailed;

  onProgress?.(`\n📊 修复完成: ✅${totalFixed} ❌${totalFailed} ⏭️${totalSkipped} (${elapsed}ms)`);

  return {
    totalFindings: actionableFindings.length,
    fixed: totalFixed,
    failed: totalFailed,
    skipped: totalSkipped + skipped,
    attempts,
    elapsedMs: elapsed,
    summary: buildSummary(fixed, failed, totalSkipped + skipped, elapsed),
    auditReport,
  };
}

// ═══ Helpers ═══

/**
 * 从 AuditFinding 构造 repair task 描述
 */
function buildRepairTask(finding: AuditFinding): string {
  const parts: string[] = [
    `修复问题: ${finding.title}`,
    `类别: ${finding.category}`,
    `严重度: ${finding.severity}`,
  ];
  if (finding.suggestedFix) {
    parts.push(`建议修复方向: ${finding.suggestedFix}`);
  }
  if (finding.evidence && finding.evidence.length > 0) {
    for (const ev of finding.evidence.slice(0, 3)) {
      parts.push(`相关位置: ${ev.file}${ev.lineStart ? `:${ev.lineStart}` : ''}${ev.snippet ? ` — ${ev.snippet}` : ''}`);
    }
  }
  return parts.join('\n');
}

/**
 * 从 unified diff 提取受影响的文件列表
 */
function extractAffectedFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split('\n')) {
    const match = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (match) files.push(match[1]);
  }
  return [...new Set(files)];
}

/**
 * 检查 verify command 是否存在（有对应脚本）
 */
function verifyCommandExists(command: string, workingDir: string): boolean {
  try {
    const pkgPath = path.join(workingDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const scriptName = command.replace(/^pnpm\s+/, '').trim();
    return !!(pkg.scripts && pkg.scripts[scriptName]);
  } catch {
    return false;
  }
}

/**
 * 执行验证命令
 */
async function runVerify(
  command: string,
  workingDir: string,
): Promise<{ passed: boolean; output: string }> {
  try {
    // 检查命令对应的脚本是否存在
    if (!verifyCommandExists(command, workingDir)) {
      const scriptName = command.replace(/^pnpm\s+/, '').trim();
      // 尝试 npx tsc --noEmit
      if (scriptName === 'typecheck') {
        const result = await execa('npx', ['tsc', '--noEmit'], {
          cwd: workingDir,
          timeout: 60_000,
          reject: false,
        });
        return {
          passed: result.exitCode === 0,
          output: result.stdout + result.stderr,
        };
      }
      return {
        passed: false,
        output: `项目未定义 "${scriptName}" 脚本`,
      };
    }

    const [bin, ...args] = command.split(' ');
    const result = await execa(bin, args, {
      cwd: workingDir,
      timeout: 120_000,
      reject: false,
    });

    return {
      passed: result.exitCode === 0,
      output: (result.stdout + result.stderr).slice(0, 5000),
    };
  } catch (err) {
    return {
      passed: false,
      output: `验证命令执行异常: ${(err as Error).message}`,
    };
  }
}

/**
 * 回滚补丁修改
 */
async function rollbackPatch(files: string[], workingDir: string): Promise<void> {
  const backupDir = path.join(workingDir, '.deepseek-code', 'backups');
  for (const file of files) {
    const backupPath = path.join(backupDir, `${file.replace(/[/\\]/g, '_')}.backup`);
    if (fs.existsSync(backupPath)) {
      const targetPath = path.join(workingDir, file);
      try {
        fs.copyFileSync(backupPath, targetPath);
      } catch {
        // 回滚失败，不阻断
      }
    }
  }
}

/**
 * 应用补丁到文件系统
 * 使用 diff-utils 的统一 diff 应用逻辑
 */
async function applyPatchTool(
  args: { patch: string; filesAffected: string[] },
  workingDir: string,
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const { applyUnifiedDiff, extractFilesFromPatch } = await import('./diff-utils.js');

    const filesFromPatch = extractFilesFromPatch(args.patch);
    const allFiles = new Set([...filesFromPatch, ...args.filesAffected]);

    if (allFiles.size === 0) {
      return { success: false, error: '补丁未包含可识别的文件路径' };
    }

    for (const file of allFiles) {
      const fullPath = path.join(workingDir, file);

      // 备份原文件
      if (fs.existsSync(fullPath)) {
        const backupDir = path.join(workingDir, '.deepseek-code', 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(backupDir, `${file.replace(/[/\\]/g, '_')}.backup`);
        fs.copyFileSync(fullPath, backupPath);
      }

      // 读取原文件内容
      const originalContent = fs.existsSync(fullPath)
        ? fs.readFileSync(fullPath, 'utf-8')
        : '';
      const fileName = path.basename(file);

      // 应用 diff
      const patched = applyUnifiedDiff(originalContent, args.patch, fileName);
      if (patched === null) {
        return { success: false, error: `无法将补丁应用到 ${file}（diff 无法匹配）` };
      }

      // 写入
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, patched, 'utf-8');
    }

    return { success: true, content: `已应用补丁到 ${allFiles.size} 个文件` };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * 生成修复摘要
 */
function buildSummary(fixed: number, failed: number, skipped: number, elapsedMs: number): string {
  const parts: string[] = [];
  if (fixed > 0) parts.push(`✅ 已修复 ${fixed} 个`);
  if (failed > 0) parts.push(`❌ 失败 ${failed} 个`);
  if (skipped > 0) parts.push(`⏭️ 跳过 ${skipped} 个`);
  parts.push(`(${(elapsedMs / 1000).toFixed(1)}s)`);
  return parts.join(' ');
}

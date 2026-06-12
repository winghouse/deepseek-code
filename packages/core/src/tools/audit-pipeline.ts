// ============================================================
// Verified Audit Pipeline
// audit_task 的执行器：确定性检查 → 证据收集 → 验证 → 报告
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AuditFinding, AuditEvidence, AuditReport, AuditScope, FindingKind, EvidenceStrength } from 'deepseek-code-shared';
import { auditTools } from './audit-tools.js';
import { scanRepo } from '../context/scanner.js';

const DEFAULT_SCOPES: AuditScope[] = ['maintainability', 'architecture', 'test', 'config', 'security', 'dead-code', 'docs'];

export interface PipelineOptions {
  workingDir: string;
  scope?: string[];
  verifiedOnly?: boolean;
  /** 审计模式: quick=确定性 / standard=+Flash / deep=+Pro复核 */
  mode?: 'quick' | 'standard' | 'deep';
  /** 审计范围 */
  scopes?: AuditScope[];
  /** Flash 模型客户端——用于生成候选发现 */
  flashClient?: { chat(prompt: string): Promise<string> };
  /** Pro 模型客户端——用于复核高风险发现 */
  proClient?: { chat(prompt: string): Promise<string> };
  /** 进度回调——用于流式输出 */
  onProgress?: (step: string) => void;
}

/**
 * Verified Audit Pipeline
 *
 * repo_map → deterministic_checks → candidate_findings →
 * evidence_collect → verifyFinding → final_report
 */
export async function runAuditPipeline(
  options: PipelineOptions,
): Promise<AuditReport> {
  const start = Date.now();
  const { workingDir, verifiedOnly = true } = options;
  const at = auditTools(workingDir);

  const findings: AuditFinding[] = [];
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${String(++idCounter).padStart(3, '0')}`;

  const tick = () => new Promise(r => setTimeout(r, 0));

  // ═══ Step 1: repo_map ═══
  options.onProgress?.('🔍 扫描项目结构...');
  await tick();
  const repoInfo = await scanRepo({ workingDir });

  // ═══ Step 2: deterministic checks ═══
  options.onProgress?.('🔬 确定性检查 (跨平台/配置/死代码)...');
  await tick();
  const scripts = at.listScripts();
  const crossPlatform = at.detectCrossPlatform();
  const scriptsType = at.readJsonPath('package.json', '$.scripts');
  const tsconfigExists = at.fileExists('tsconfig.base.json');
  const eslintExists = at.fileExists('.eslintrc.json');
  const editorconfigExists = at.fileExists('.editorconfig');
  const readmeExists = at.fileExists('README.md');

  // Check sub-packages
  const pkgFiles = findPkgJsons(workingDir);
  const missingModules: string[] = [];
  const missingLints: string[] = [];
  const crossPlatformScripts: string[] = [];

  for (const pkgFile of pkgFiles) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
      const name = pkg.name ?? pkgFile;
      // Check type:module
      if (!pkg.type || pkg.type !== 'module') {
        missingModules.push(name);
      }
      // Check lint script
      if (!pkg.scripts?.lint) {
        missingLints.push(name);
      }
    } catch { /* skip */ }
  }

  // ═══ Step 3: candidate_findings + evidence ═══

  // CP001: cross-platform scripts
  const cpIssues = (crossPlatform.metadata as { issues?: string[] } | undefined)?.issues ?? [];
  if (cpIssues.length > 0) {
    const evidence: AuditEvidence[] = [{
      file: 'package.json', jsonPath: '$.scripts',
      snippet: cpIssues.slice(0, 3).join('\n'),
      tool: 'list_scripts',
    }];
    findings.push({
      id: nextId('CP'), title: '跨平台脚本不兼容',
      category: 'cross-platform', severity: 'medium',
      claim: `检测到 ${cpIssues.length} 个跨平台风险命令`,
      evidence, verificationStatus: 'verified', confidence: 1,
      suggestedFix: '将 rm -rf 替换为 rimraf 或 Node.js 原生 fs.rmSync',
    });
  }

  // CF001: missing lint scripts
  if (missingLints.length > 0) {
    findings.push({
      id: nextId('CF'), title: '子包缺少 lint 脚本',
      category: 'config', severity: 'low',
      claim: `以下包缺少 lint 脚本: ${missingLints.join(', ')}`,
      evidence: [{ file: 'package.json', jsonPath: '$.scripts', snippet: missingLints.join('\n'), tool: 'list_scripts' }],
      verificationStatus: 'verified', confidence: 1,
      suggestedFix: '在子包 package.json 中添加 "lint": "tsc --noEmit"',
    });
  }

  // CF002: missing ESLint
  findings.push({
    id: nextId('CF'), title: '缺少 ESLint 配置',
    category: 'config', severity: 'low',
    claim: '项目无 ESLint 配置文件',
    evidence: [{ file: '.eslintrc.json', snippet: eslintExists.content, tool: 'file_exists' }],
    verificationStatus: eslintExists.metadata?.exists ? 'rejected' : 'verified',
    confidence: 1,
    rejectionReason: eslintExists.metadata?.exists ? '文件已存在' : undefined,
  });

  // CF003: missing EditorConfig
  findings.push({
    id: nextId('CF'), title: '缺少 .editorconfig',
    category: 'config', severity: 'low',
    claim: '项目无 .editorconfig 文件',
    evidence: [{ file: '.editorconfig', snippet: editorconfigExists.content, tool: 'file_exists' }],
    verificationStatus: editorconfigExists.metadata?.exists ? 'rejected' : 'verified',
    confidence: 1,
  });

  // 死代码、文档、类型安全等交给 Flash 模型审查，不做硬编码检查

  // ═══ Step 4: Flash 生成候选发现 ═══
  if (options.flashClient) {
    options.onProgress?.('🤖 Flash 模型生成候选发现...');
    await tick();
    try {
      const repoSummary = {
        name: repoInfo.name,
        language: repoInfo.techStack.language,
        framework: repoInfo.techStack.framework,
        packageManager: repoInfo.techStack.packageManager,
        testFramework: repoInfo.techStack.testFramework,
        hasLint: at.fileExists('.eslintrc.json').metadata?.exists,
        hasEditorConfig: at.fileExists('.editorconfig').metadata?.exists,
        scripts: (at.listScripts().metadata as Record<string, unknown>)?.keys ?? [],
        crossPlatformIssues: (crossPlatform.metadata as Record<string, unknown>)?.issues ?? [],
      };

      // 收集已由确定性检查发现的问题，避免 Flash 重复
      const alreadyFound = findings.filter((f) => f.verificationStatus === 'verified' || f.verificationStatus === 'partial');
      const alreadyFoundSummary = alreadyFound.map((f) => `- [${f.verificationStatus}] ${f.title}: ${f.claim}`).join('\n');

      const flashPrompt = [
        '你是一个资深代码审查专家。对项目做全面审查，按维度提出发现。',
        '输出 JSON 数组，每个元素有 title, claim, category, severity, verified 字段。',
        'category: config|test|type-safety|dead-code|docs|security|cross-platform|architecture|maintainability|error-handling|performance|dependency',
        'severity: low|medium|high',
        'verified: true=你实际读到文件确认过 | false=基于项目信息推测(会被降级)',
        '',
        '铁律: 如果你没有实际读到相关文件，verified 必须为 false。severity=high 的发现必须 verified=true。',
        '',
        '⚠️ 以下问题已被确定性检查发现，严禁重复：',
        alreadyFoundSummary || '(无)',
        '',
        '请覆盖以下维度，每个维度 1-3 条：',
        '1. 架构 2. 安全 3. 可维护性 4. 测试 5. 错误处理 6. 性能 7. 依赖',
        '',
        '项目信息: ' + JSON.stringify(repoSummary),
      ].join('\n');

      const raw = await options.flashClient.chat(flashPrompt);
      const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/) ?? [null, raw];
      const candidates = JSON.parse((jsonMatch[1] ?? raw).trim()) as Array<{ title: string; claim: string; category: string; severity: string; verified?: boolean }>;

      for (const c of candidates) {
        // 未验证 + severity=high → 降级到 medium
        const isVerified = c.verified !== false;
        const sev = (c.severity as AuditFinding['severity']) ?? 'medium';
        const adjustedSeverity: AuditFinding['severity'] = (!isVerified && sev === 'high') ? 'medium' : sev;

        const f: AuditFinding = {
          id: nextId('FL'), title: c.title,
          category: (c.category as AuditFinding['category']) ?? 'maintainability',
          severity: adjustedSeverity,
          claim: c.claim,
          evidence: [],
          verificationStatus: 'unverified',
          confidence: 0.5,
        };

        // 自动去重：检查是否与已有确定性发现重复
        const isDuplicate = alreadyFound.some((existing) => {
          const t1 = (c.title + c.claim).toLowerCase();
          const t2 = (existing.title + existing.claim).toLowerCase();
          // 关键词重叠检测
          const keywords = ['eslint', 'editorconfig', 'strict', '跨平台', 'lint', 'type', 'typescript'];
          return keywords.some((kw) => t1.includes(kw) && t2.includes(kw));
        });
        if (isDuplicate) {
          f.verificationStatus = 'rejected';
          f.rejectionReason = '与确定性检查发现重复，自动驳回';
          f.confidence = 0;
          findings.push(f);
          continue;
        }

        // 尝试收集证据
        if (c.title.toLowerCase().includes('test') || c.title.includes('测试')) {
          const testFiles = at.findReferences('.test.');
          if (testFiles.content.length > 0) {
            f.evidence.push({ file: '*.test.ts', snippet: testFiles.content.slice(0, 300), tool: 'find_references' });
            f.confidence = 0.7;
          }
        }
        if (c.title.toLowerCase().includes('doc') || c.title.includes('文档')) {
          const readme = at.fileExists('README.md');
          f.evidence.push({ file: 'README.md', snippet: readme.content, tool: 'file_exists' });
        }
        at.verifyFinding(f);
        findings.push(f);
      }
    } catch (e) {
      // Flash 候选生成失败不阻塞 pipeline
      findings.push({
        id: nextId('FL'), title: 'Flash 候选扫描失败',
        category: 'maintainability', severity: 'low',
        claim: `Flash 模型调用失败: ${String(e).slice(0, 100)}`,
        evidence: [], verificationStatus: 'rejected', confidence: 0,
        rejectionReason: '模型调用异常',
      });
    }
  }

  // ═══ Step 5: verify all ═══
  options.onProgress?.(`验证 ${findings.length} 条发现...`);
  await tick();
  for (const f of findings) {
    at.verifyFinding(f);
  }

  // ═══ Step 6: report ═══
  options.onProgress?.('📝 生成报告...');
  await tick();
  const verified = findings.filter((f) => f.verificationStatus === 'verified');
  const partial = findings.filter((f) => f.verificationStatus === 'partial');
  const rejected = findings.filter((f) => f.verificationStatus === 'rejected');
  const unverified = findings.filter((f) => f.verificationStatus === 'unverified');
  const needsManualReview = findings.filter((f) => f.findingKind === 'needs_manual_review');

  // 过滤纯正面报告
  const isPositiveOnly = (f: AuditFinding) => f.title.includes('✅');
  const actionable = findings.filter((f) => !isPositiveOnly(f));

  // displayed = verified + partial + needs_manual_review
  // hidden = rejected
  const displayed = actionable.filter((f) => f.verificationStatus !== 'rejected');
  // unverified 仅在 flash 可用时展示
  const reportFindings = verifiedOnly
    ? [...displayed.filter((f) => f.verificationStatus === 'verified' || f.verificationStatus === 'partial' || f.findingKind === 'needs_manual_review'), ...(options.flashClient ? displayed.filter((f) => f.verificationStatus === 'unverified') : [])]
    : displayed;

  return {
    totalCandidates: findings.length,
    verified: verified.length,
    partial: partial.length,
    rejected: rejected.length,
    needsManualReview: needsManualReview.length,
    findings: reportFindings,
    rejectedFindings: rejected,
    elapsedMs: Date.now() - start,
    tokensEstimate: 0,
    scopes: options.scopes ?? DEFAULT_SCOPES,
    mode: options.mode ?? 'standard',
  };
}

/** 查找所有 package.json */
function findPkgJsons(dir: string): string[] {
  const results: string[] = [];
  try {
    const walk = (d: string, depth: number) => {
      if (depth > 3) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
        if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
        else if (e.name === 'package.json') results.push(path.join(d, e.name));
      }
    };
    walk(dir, 0);
  } catch { /* ignore */ }
  return results;
}

/** 格式化 audit 报告为 Markdown */
export function formatAuditReport(report: AuditReport): string {
  const lines = [
    '# Verified Audit Report',
    '',
    `模式: **${report.mode ?? 'standard'}**`,
    `范围: ${(report.scopes ?? DEFAULT_SCOPES).join(' / ')}`,
    `候选发现: ${report.totalCandidates}`,
    `验证通过: ${report.verified}  |  部分成立: ${report.partial}  |  需人工确认: ${report.needsManualReview ?? 0}  |  已驳回: ${report.rejected}`,
    `耗时: ${(report.elapsedMs / 1000).toFixed(1)}s`,
    '',
    '---',
    '',
  ];

  if (report.findings.length === 0) {
    lines.push('✅ 未发现问题。');
    return lines.join('\n');
  }

  const confirmed = report.findings.filter((f) => f.verificationStatus !== 'unverified');
  const unverified = report.findings.filter((f) => f.verificationStatus === 'unverified');
  const manualReview = confirmed.filter((f) => f.findingKind === 'needs_manual_review');
  const issues = confirmed.filter((f) => f.findingKind !== 'needs_manual_review');
  const highPriority = issues.filter((f) => f.severity === 'high' || f.severity === 'medium');
  const lowPriority = issues.filter((f) => f.severity === 'low');

  // 需要优先处理
  if (highPriority.length > 0) {
    lines.push('## 🔴 需要优先处理');
    lines.push('');
    for (const f of highPriority) {
      lines.push(...formatFindingLines(f));
    }
  }

  // 可清理项
  if (lowPriority.length > 0) {
    lines.push('## 🟢 可清理项');
    lines.push('');
    for (const f of lowPriority) {
      lines.push(...formatFindingLines(f));
    }
  }

  // 需要人工确认
  if (manualReview.length > 0) {
    lines.push('## 🟡 需要人工确认');
    lines.push('');
    lines.push('> 以下发现证据不足，无法程序判断，需要人工核实。');
    lines.push('');
    for (const f of manualReview) {
      lines.push(...formatFindingLines(f));
    }
  }

  // AI 候选
  if (unverified.length > 0) {
    lines.push('## 🤖 AI 候选发现（未经确定性验证）');
    lines.push('');
    lines.push('> 以下由 Flash 模型生成，**未经验证**，仅供参考，可能存在幻觉。');
    lines.push('');
    for (const f of unverified) {
      lines.push(...formatFindingLines(f));
    }
  }

  // 已驳回摘要
  if (report.rejectedFindings && report.rejectedFindings.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(`### 📋 已隐藏 ${report.rejectedFindings.length} 条已驳回发现`);
    lines.push('');
    for (const f of report.rejectedFindings) {
      lines.push(`- ❌ **${f.title}**: ${f.rejectionReason ?? '驳回'}`);
    }
    lines.push('');
    lines.push('> 使用 `--show-rejected` 查看详情');
    lines.push('');
  }

  return lines.join('\n');
}

function formatFindingLines(f: AuditFinding): string[] {
  const icon = f.findingKind === 'needs_manual_review' ? '👤'
    : f.verificationStatus === 'verified' ? '✅'
    : f.verificationStatus === 'partial' ? '⚠️'
    : f.verificationStatus === 'unverified' ? '🤖' : '❌';
  const strengthLabel = f.evidenceStrength === 'strong' ? '[强证据]'
    : f.evidenceStrength === 'medium' ? '[中证据]' : f.evidenceStrength === 'weak' ? '[弱证据]' : '';
  const lines = [
    `### ${icon} ${f.id}: ${f.title} ${strengthLabel}`,
    `Severity: **${f.severity}**  |  Confidence: ${(f.confidence * 100).toFixed(0)}%`,
    `> ${f.claim}`,
    '',
    '**Evidence:**',
  ];
  for (const e of f.evidence) {
    lines.push(`- \`${e.tool}\`: ${e.file}${e.jsonPath ? ' ' + e.jsonPath : ''}${e.symbol ? ' ' + e.symbol : ''}`);
    if (e.snippet && e.snippet.length < 200) lines.push(`  \`\`\`\n  ${e.snippet}\n  \`\`\``);
  }
  if (f.suggestedFix) lines.push(`\n**Fix:** ${f.suggestedFix}`);
  lines.push('');
  return lines;
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    'config': '配置',
    'test': '测试',
    'type-safety': '类型安全',
    'dead-code': '死代码',
    'docs': '文档',
    'security': '安全',
    'cross-platform': '跨平台',
    'architecture': '架构',
    'maintainability': '可维护性',
  };
  return labels[cat] ?? cat;
}

// ============================================================
// AutoFix Loop 测试
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuditFinding, AuditReport } from 'deepseek-code-shared';

// ═══ Module-level mocks (ESM) ═══

const mockFsExistsSync = vi.fn();
const mockFsReadFileSync = vi.fn();
const mockFsWriteFileSync = vi.fn();
const mockFsCopyFileSync = vi.fn();
const mockFsMkdirSync = vi.fn();

vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: any[]) => mockFsExistsSync(...args),
    readFileSync: (...args: any[]) => mockFsReadFileSync(...args),
    writeFileSync: (...args: any[]) => mockFsWriteFileSync(...args),
    copyFileSync: (...args: any[]) => mockFsCopyFileSync(...args),
    mkdirSync: (...args: any[]) => mockFsMkdirSync(...args),
  },
  existsSync: (...args: any[]) => mockFsExistsSync(...args),
  readFileSync: (...args: any[]) => mockFsReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockFsWriteFileSync(...args),
  copyFileSync: (...args: any[]) => mockFsCopyFileSync(...args),
  mkdirSync: (...args: any[]) => mockFsMkdirSync(...args),
}));

vi.mock('../src/tools/audit-pipeline.js', () => ({
  runAuditPipeline: vi.fn(),
}));

vi.mock('../src/tools/repair-pipeline.js', () => ({
  runRepairPipeline: vi.fn(),
}));

vi.mock('../src/tools/diff-utils.js', () => ({
  applyUnifiedDiff: vi.fn(),
  extractFilesFromPatch: vi.fn(),
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { runAutoFixLoop } from '../src/tools/autofix-loop.js';
import { runAuditPipeline } from '../src/tools/audit-pipeline.js';
import { runRepairPipeline } from '../src/tools/repair-pipeline.js';
import { applyUnifiedDiff, extractFilesFromPatch } from '../src/tools/diff-utils.js';
import { execa } from 'execa';

const mockAudit = runAuditPipeline as ReturnType<typeof vi.fn>;
const mockRepair = runRepairPipeline as ReturnType<typeof vi.fn>;
const mockApplyDiff = applyUnifiedDiff as ReturnType<typeof vi.fn>;
const mockExtractFiles = extractFilesFromPatch as ReturnType<typeof vi.fn>;
const mockExeca = execa as ReturnType<typeof vi.fn>;

// ═══ Helpers ═══

function buildAuditReport(findings: Partial<AuditFinding>[]): AuditReport {
  return {
    totalCandidates: findings.length,
    verified: findings.filter(f => f.verificationStatus === 'verified').length,
    partial: findings.filter(f => f.verificationStatus === 'partial').length,
    rejected: findings.filter(f => f.verificationStatus === 'rejected').length,
    findings: findings.map((f, i) => ({
      id: f.id || `F-${String(i + 1).padStart(3, '0')}`,
      title: f.title || `Issue ${i + 1}`,
      category: f.category || 'maintainability',
      severity: f.severity || 'medium',
      claim: f.claim || 'Mock claim',
      evidence: f.evidence || [],
      verificationStatus: f.verificationStatus || 'verified',
      confidence: f.confidence ?? 0.8,
      suggestedFix: f.suggestedFix,
    })),
    elapsedMs: 10,
    tokensEstimate: 0,
  };
}

function buildRepairSuccess(patch?: string) {
  return Promise.resolve({
    success: true,
    summary: '修复成功',
    filesExamined: ['src/test.ts'],
    patchProposal: patch || '--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1 +1 @@\n- old\n+ new',
    rootCause: '类型不匹配',
    rootCauseConfidence: 0.9,
    elapsedMs: 10,
  });
}

function buildRepairFailure() {
  return Promise.resolve({
    success: false,
    summary: '无法生成修复方案',
    filesExamined: [],
    elapsedMs: 10,
  });
}

function setupDefaults() {
  mockExtractFiles.mockReturnValue(['src/test.ts']);
  mockApplyDiff.mockReturnValue('patched content');
  mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockFsExistsSync.mockReturnValue(true);
  mockFsReadFileSync.mockReturnValue(JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }));
  mockFsWriteFileSync.mockImplementation(() => {});
  mockFsCopyFileSync.mockImplementation(() => {});
  mockFsMkdirSync.mockImplementation(() => {});
}

// ═══ Tests ═══

describe('runAutoFixLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  // ---- Readonly ----

  describe('readonly 模式', () => {
    it('只审计不修复', async () => {
      mockAudit.mockResolvedValue(buildAuditReport([
        { id: 'F-001', title: 'Missing test', severity: 'medium', verificationStatus: 'verified' },
      ]));

      const result = await runAutoFixLoop({ workingDir: '/tmp/test', mode: 'readonly' });

      expect(result.fixed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockRepair).not.toHaveBeenCalled();
    });

    it('多个 findings 也跳过', async () => {
      mockAudit.mockResolvedValue(buildAuditReport([
        { id: 'F-001', title: 'Bug', severity: 'high', verificationStatus: 'verified' },
        { id: 'F-002', title: 'Smell', severity: 'low', verificationStatus: 'verified' },
      ]));

      const result = await runAutoFixLoop({ workingDir: '/tmp/test', mode: 'readonly' });

      expect(result.fixed).toBe(0);
      expect(result.skipped).toBe(2);
    });
  });

  // ---- 无待修复项 ----

  describe('无待修复项', () => {
    it('全部被拒绝 → 跳过', async () => {
      mockAudit.mockResolvedValue(buildAuditReport([
        { id: 'F-001', title: 'Nope', severity: 'high', verificationStatus: 'rejected' },
      ]));

      const result = await runAutoFixLoop({ workingDir: '/tmp/test', mode: 'auto' });

      expect(result.totalFindings).toBe(0);
      expect(result.fixed).toBe(0);
    });

    it('空 findings → 直接返回', async () => {
      mockAudit.mockResolvedValue(buildAuditReport([]));

      const result = await runAutoFixLoop({ workingDir: '/tmp/test', mode: 'auto' });

      expect(result.totalFindings).toBe(0);
      expect(result.summary).toContain('未发现');
    });
  });

  // ---- 修复成功 ----

  describe('修复成功', () => {
    it('单 finding 一轮修复成功', async () => {
      mockAudit.mockResolvedValue(buildAuditReport([
        { id: 'F-001', title: 'TS Error', severity: 'high', verificationStatus: 'verified' },
      ]));
      mockRepair.mockReturnValue(buildRepairSuccess());

      const result = await runAutoFixLoop({ workingDir: '/tmp/test', mode: 'auto', maxRetries: 3 });

      expect(result.fixed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.attempts[0].status).toBe('fixed');
      expect(mockRepair).toHaveBeenCalledTimes(1);
    });

    it('按严重度排序 (high → medium → low)', async () => {
      mockAudit.mockResolvedValue(buildAuditReport([
        { id: 'F-low', title: 'Low', severity: 'low', verificationStatus: 'verified' },
        { id: 'F-high', title: 'High', severity: 'high', verificationStatus: 'verified' },
        { id: 'F-med', title: 'Med', severity: 'medium', verificationStatus: 'verified' },
      ]));
      mockRepair.mockReturnValue(buildRepairSuccess());

      const result = await runAutoFixLoop({ workingDir: '/tmp/test', mode: 'auto' });

      expect(result.attempts[0].findingTitle).toBe('High');
      expect(result.attempts[1].findingTitle).toBe('Med');
      expect(result.attempts[2].findingTitle).toBe('Low');
    });
  });

  // ---- 重试 ----

  describe('修复失败与重试', () => {
    it('首次 verify 失败 → 回滚 → 第二轮成功', async () => {
      mockAudit.mockResolvedValue(buildAuditReport([
        { id: 'F-001', title: 'Bug', severity: 'high', verificationStatus: 'verified' },
      ]));
      mockRepair.mockReturnValue(buildRepairSuccess('patch1'));
      mockExeca
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'Error' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      const result = await runAutoFixLoop({ workingDir: '/tmp/test', mode: 'auto', maxRetries: 3 });

      // 应该有 rolled_back + fixed 两条记录
      const forFinding = result.attempts.filter(a => a.findingId === 'F-001');
      expect(forFinding.some(a => a.status === 'rolled_back')).toBe(true);
      expect(forFinding.some(a => a.status === 'fixed')).toBe(true);
    });

    it('全部重试失败 → failed', async () => {
      mockAudit.mockResolvedValue(buildAuditReport([
        { id: 'F-001', title: 'Hard Bug', severity: 'high', verificationStatus: 'verified' },
      ]));
      mockRepair.mockReturnValue(buildRepairSuccess('patch'));
      mockExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'Error' });

      const result = await runAutoFixLoop({ workingDir: '/tmp/test', mode: 'auto', maxRetries: 2 });

      expect(result.fixed).toBe(0);
      expect(result.failed).toBe(1);
    });

    it('repair 不生成方案 → 不重试', async () => {
      mockAudit.mockResolvedValue(buildAuditReport([
        { id: 'F-001', title: 'Weird', severity: 'medium', verificationStatus: 'verified' },
      ]));
      mockRepair.mockReturnValue(buildRepairFailure());

      const result = await runAutoFixLoop({ workingDir: '/tmp/test', mode: 'auto', maxRetries: 3 });

      expect(result.fixed).toBe(0);
      expect(result.failed).toBe(1);
      expect(mockRepair).toHaveBeenCalledTimes(1);
    });
  });

  // ---- 严重度过滤 ----

  describe('严重度过滤', () => {
    it('minSeverity=medium → 跳过 low', async () => {
      mockAudit.mockResolvedValue(buildAuditReport([
        { id: 'F-low', title: 'Low', severity: 'low', verificationStatus: 'verified' },
        { id: 'F-med', title: 'Med', severity: 'medium', verificationStatus: 'verified' },
      ]));
      mockRepair.mockReturnValue(buildRepairSuccess());

      const result = await runAutoFixLoop({ workingDir: '/tmp/test', mode: 'auto', minSeverity: 'medium' });

      expect(result.totalFindings).toBe(1);
      expect(result.attempts[0].findingTitle).toBe('Med');
    });
  });

  // ---- 结构 ----

  describe('结果结构', () => {
    it('返回完整结果', async () => {
      mockAudit.mockResolvedValue(buildAuditReport([
        { id: 'F-001', title: 'Bug', severity: 'high', verificationStatus: 'verified' },
      ]));
      mockRepair.mockReturnValue(buildRepairSuccess());

      const result = await runAutoFixLoop({ workingDir: '/tmp/test', mode: 'auto' });

      expect(result.auditReport).toBeDefined();
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(result.summary).toContain('已修复');
      expect(result.attempts[0].findingId).toBe('F-001');
      expect(result.attempts[0].startedAt).toBeDefined();
      expect(result.attempts[0].endedAt).toBeDefined();
    });
  });
});

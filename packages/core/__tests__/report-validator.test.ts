// ============================================================
// report-validator 测试
// ============================================================

import { describe, it, expect } from 'vitest';
import { validateReportAnchors, buildRetryPrompt, buildDegradedReport } from '../src/agent/report-validator.js';

describe('validateReportAnchors', () => {
  const known = [
    'packages/core/src/agent/router.ts',
    'packages/core/src/agent/loop.ts',
    'packages/core/src/tools/executors.ts',
    'package.json',
    'README.md',
  ];

  it('短答案 allowShortAnswer → 放行', () => {
    const r = validateReportAnchors('这个文件没问题。', known, { allowShortAnswer: true });
    expect(r.valid).toBe(true);
  });

  it('短答案不允许短答案 → 判 no_file_refs', () => {
    const r = validateReportAnchors('这个文件没问题。', known, { allowShortAnswer: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('no_file_refs');
  });

  it('虚假路径 package.js → fake_paths', () => {
    const r = validateReportAnchors('[package.js:1] 缺少配置', known, { allowShortAnswer: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('fake_paths');
    expect(r.fakePaths).toContain('package.js');
  });

  it('虚假路径 tsconfig.base.js → fake_paths', () => {
    const r = validateReportAnchors('[tsconfig.base.js:1] 缺少 strict', known, { allowShortAnswer: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('fake_paths');
  });

  it('真实路径+行号 → 通过', () => {
    const r = validateReportAnchors('[packages/core/src/agent/router.ts:120] 路由逻辑可优化', known, { allowShortAnswer: false });
    expect(r.valid).toBe(true);
  });

  it('真实路径无行号 → missing_locations', () => {
    const r = validateReportAnchors('packages/core/src/agent/router.ts 需要优化', known, { allowShortAnswer: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('missing_locations');
  });

  it('短路径匹配: router.ts 匹配完整路径', () => {
    const r = validateReportAnchors('[router.ts:120] 路由优化', known, { allowShortAnswer: false });
    expect(r.valid).toBe(true);
    expect(r.citedFiles).toContain('router.ts');
  });

  it('多个假路径 → 全部检测', () => {
    const r = validateReportAnchors('[package.js:1] [tsconfig.base.js:2] 问题', known, { allowShortAnswer: false });
    expect(r.valid).toBe(false);
    expect(r.fakePaths.length).toBe(2);
  });

  it('完全没有文件引用 → no_file_refs', () => {
    const r = validateReportAnchors('这是一段很长的分析文字但没有引用任何文件路径。'.repeat(10), known, { allowShortAnswer: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('no_file_refs');
  });

  it('混合真假路径 → fake_paths', () => {
    const r = validateReportAnchors('[router.ts:120] 和 [fake-file.ts:1]', known, { allowShortAnswer: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('fake_paths');
    expect(r.fakePaths).toContain('fake-file.ts');
  });

  it('Windows 反斜杠路径 → 通过', () => {
    const knownWin = ['packages\\core\\src\\agent\\router.ts'];
    const r = validateReportAnchors('[router.ts:120] 问题', knownWin, { allowShortAnswer: false });
    expect(r.valid).toBe(true);
  });

  it('README.md 在已知文件中 → 通过', () => {
    const r = validateReportAnchors('[README.md:8] 测试数量未更新', known, { allowShortAnswer: false });
    expect(r.valid).toBe(true);
  });
});

describe('buildRetryPrompt', () => {
  const known = ['packages/core/src/agent/router.ts', 'packages/core/src/agent/loop.ts'];

  it('fake_paths → 提示包含假路径和真实列表', () => {
    const v = validateReportAnchors('[package.js:1]', known, { allowShortAnswer: false });
    const p = buildRetryPrompt(v);
    expect(p).toContain('package.js');
    expect(p).toContain('router.ts');
    expect(p).toContain('[文件:行号]');
  });

  it('missing_locations → 提示标行号', () => {
    const v = validateReportAnchors('packages/core/src/agent/router.ts 需要优化', known, { allowShortAnswer: false });
    const p = buildRetryPrompt(v);
    expect(p).toContain('行号');
    expect(p).toContain('router.ts');
  });

  it('no_file_refs → 提示引用文件', () => {
    const v = validateReportAnchors('没有引用', known, { allowShortAnswer: false });
    const p = buildRetryPrompt(v);
    expect(p).toContain('引用');
    expect(p).toContain('router.ts');
  });
});

describe('buildDegradedReport', () => {
  it('包含已读文件列表', () => {
    const r = buildDegradedReport(['router.ts', 'loop.ts']);
    expect(r).toContain('router.ts');
    expect(r).toContain('未能生成');
  });
});

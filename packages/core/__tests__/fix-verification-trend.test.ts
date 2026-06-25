// ============================================================
// Fix Verification Trend 层测试
// ============================================================

import { describe, it, expect } from 'vitest';
import { runFixVerification } from '../src/tools/fix-verification.js';
import type { FixBaselineItem, VerifiedFix } from '../src/tools/fix-verification.js';

/** 模拟两轮结果并 diff */
function diffRounds(
  prev: VerifiedFix[],
  curr: VerifiedFix[],
): { improved: string[]; regressed: string[]; hidden: string[] } {
  const prevMap = new Map<string, VerifiedFix>();
  for (const r of prev) if (r.findingId) prevMap.set(r.findingId, r);

  const improved: string[] = [];
  const regressed: string[] = [];
  const hidden: string[] = [];

  for (const cur of curr) {
    if (!cur.findingId) continue;
    const pr = prevMap.get(cur.findingId);
    if (!pr) continue;
    if (pr.status === cur.status && pr.evidenceLevel === cur.evidenceLevel) {
      hidden.push(cur.findingId);
      continue;
    }
    const isImproved = (cur.status === 'fixed' && pr.status !== 'fixed')
      || (cur.evidenceLevel === 'strong' && pr.evidenceLevel !== 'strong');
    const isRegressed = (pr.status === 'fixed' && cur.status !== 'fixed')
      || (pr.evidenceLevel === 'strong' && cur.evidenceLevel !== 'strong');
    if (isImproved) improved.push(cur.findingId);
    else if (isRegressed) regressed.push(cur.findingId);
  }

  return { improved, regressed, hidden };
}

describe('Trend — 两轮结果 diff', () => {
  const baseline: FixBaselineItem[] = [
    { title: 'SSRF', findingId: 'ssrf_001', source: 'session', keywords: ['SSRF', '169.254'] },
    { title: 'search errors', findingId: 'search_002', source: 'session', keywords: ['search', 'catch'] },
    { title: 'parseToolArgs', findingId: 'parse_003', source: 'session', keywords: ['parseToolArgs', 'JSON'] },
  ];

  it('partial→fixed + weak→strong → improved', () => {
    const prev: VerifiedFix[] = [{
      title: 'SSRF', findingId: 'ssrf_001', status: 'partial', evidenceLevel: 'weak',
      fixSignals: { diff: true, log: false, test: false }, evidence: ['diff'], reason: 'partial',
    }];
    const curr = runFixVerification(baseline, 'SSRF fix in diff', 'fix: SSRF patch').fixed;

    const { improved } = diffRounds(prev, curr);
    expect(improved).toContain('ssrf_001');
  });

  it('fixed→partial → regressed', () => {
    const prev: VerifiedFix[] = [{
      title: 'SSRF', findingId: 'ssrf_001', status: 'fixed', evidenceLevel: 'strong',
      fixSignals: { diff: true, log: true, test: true }, evidence: ['triple'], reason: 'fixed',
    }];
    const prevFixed = prev[0];

    // 模拟回归: 当前只命中 diff
    const { regressed } = diffRounds(prev, [{
      title: 'SSRF', findingId: 'ssrf_001', status: 'partial', evidenceLevel: 'weak',
      fixSignals: { diff: true, log: false, test: false }, evidence: ['diff_only'], reason: 'regressed',
    }]);
    expect(regressed).toContain('ssrf_001');
  });

  it('unchanged → hidden', () => {
    const r: VerifiedFix = {
      title: 'SSRF', findingId: 'ssrf_001', status: 'partial', evidenceLevel: 'weak',
      fixSignals: { diff: true, log: false, test: false }, evidence: ['diff'], reason: 'same',
    };
    const { hidden } = diffRounds([r], [r]);
    expect(hidden).toContain('ssrf_001');
  });

  it('all unchanged → diff 结果全空', () => {
    const r: VerifiedFix = {
      title: 'X', findingId: 'x_001', status: 'unknown', evidenceLevel: 'weak',
      fixSignals: { diff: false, log: false, test: false }, evidence: [], reason: 'same',
    };
    const { improved, regressed, hidden } = diffRounds([r], [r]);
    expect(improved.length).toBe(0);
    expect(regressed.length).toBe(0);
    expect(hidden).toContain('x_001');
  });

  it('新 finding 不参与 diff (previous 无此 id)', () => {
    const prev: VerifiedFix[] = [];
    const curr = runFixVerification(baseline, 'fix', 'fix commit').fixed;
    const { improved, regressed } = diffRounds(prev, curr);
    expect(improved.length).toBe(0);
    expect(regressed.length).toBe(0);
  });
});

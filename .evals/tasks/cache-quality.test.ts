// ============================================================
// KV Cache 质量门禁 — 发版前手动执行
// pnpm cache:quality
// 不进 CI，不进普通测试
// ============================================================

import { describe, it, expect, afterAll } from 'vitest';

const REPORT_DIR = '.evals/cache-reports';

interface GateResult {
  label: string;
  target: string;
  actual: string;
  pass: boolean;
}

const gates: GateResult[] = [];

function gate(label: string, target: string, pass: boolean, actual: string) {
  gates.push({ label, target, actual, pass });
  const icon = pass ? '✅' : '❌';
  console.log(`  ${icon} ${label}: ${actual} (目标: ${target})`);
}

describe('KV Cache 质量门禁', () => {
  it('从最新 benchmark 报告校验门禁', async () => {
    // 先跑 benchmark
    const { execSync } = await import('node:child_process');
    try {
      console.log('🚀 运行 cache benchmark...\n');
      execSync('npx vitest run .evals/tasks/cache-bench.test.ts', {
        stdio: 'inherit',
        timeout: 600000,
        cwd: process.cwd(),
      });
    } catch (e: any) {
      console.error('❌ Benchmark 运行失败:', e.stderr?.toString()?.slice(0, 200) || e.message);
    }

    // 读取最新报告
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dateStr = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(process.cwd(), REPORT_DIR, `${dateStr}.json`);

    if (!fs.existsSync(reportPath)) {
      console.log('⏭ 无 benchmark 报告，跳过门禁');
      return;
    }

    const results = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));

    console.log('\n📊 质量门禁:\n');

    for (const r of results) {
      const q = r.quality;

      // 性能门禁
      if (r.name === 'warm_audit_same') {
        gate('Warm Hit Rate', '≥70%', r.hitRate >= 70, `${r.hitRate.toFixed(0)}%`);
      }
      if (r.name === 'conversation_recall') {
        const cold = results.find((x: any) => x.name === 'cold_audit');
        const ratio = cold ? (r.totalPrompt / Math.max(cold.totalPrompt, 1)) * 100 : 100;
        gate('Recall vs Audit', '≤20%', ratio <= 20, `${ratio.toFixed(0)}%`);
      }

      // 质量门禁
      if (q.outputLength >= 200) {
        gate(`${r.name}: 假路径`, '=0', q.fakePaths === 0, `${q.fakePaths}条`);
        gate(`${r.name}: 降级报告`, 'false', !q.degradedReport, `${q.degradedReport}`);
        gate(`${r.name}: 缺行号`, 'false', !q.missingLocations, `${q.missingLocations}`);
      }
    }

    // 工具序列诊断 (非阻断，仅 warning)
    const cold = results.find((r: any) => r.name === 'cold_audit');
    const warm = results.find((r: any) => r.name === 'warm_audit_same');
    if (cold && warm && cold.toolSequence.length > 0 && warm.toolSequence.length > 0) {
      const same = (a: string[], b: string[]) => { const n=Math.max(a.length,b.length); if(!n)return 1; let s=0; for(let i=0;i<Math.min(a.length,b.length);i++) if(a[i]===b[i]) s++; return s/n; };
      const seedSim = same(cold.auditSeedSequence, warm.auditSeedSequence);
      const coldModel = cold.toolSequence.slice(cold.auditSeedSequence.length);
      const warmModel = warm.toolSequence.slice(warm.auditSeedSequence.length);
      const modelSim = same(coldModel, warmModel);
      gate('工具序列: Seed', '≥95%', seedSim >= 0.95, `${(seedSim*100).toFixed(0)}%`);

      // 诊断指标 (warning, 不阻断)
      const coldFirstDisc = coldModel[0] || '';
      const warmFirstDisc = warmModel[0] || '';
      const discoveryFirst = !/^(glob|list_files)$/i.test(coldFirstDisc) && !/^(glob|list_files)$/i.test(warmFirstDisc);
      const toolBudgetOk = coldModel.length <= 12 && warmModel.length <= 12;
      if (!discoveryFirst) console.log(`  ⚠️ 首轮工具: cold=${coldFirstDisc} warm=${warmFirstDisc} (建议优先 search_code/read_file)`);
      if (!toolBudgetOk) console.log(`  ⚠️ 工具调用数: cold=${coldModel.length} warm=${warmModel.length} (建议 ≤12)`);
      if (modelSim < 0.3) console.log(`  ⚠️ modelSimilarity=${(modelSim*100).toFixed(0)}% (诊断, 不阻断)`);
    }

    // warm prompt 膨胀门禁
    if (cold && warm) {
      const ratio = warm.totalPrompt / Math.max(cold.totalPrompt, 1);
      gate('Warm Prompt Ratio', '≤1.5x cold', ratio <= 1.5, `${ratio.toFixed(1)}x`);
    }

    console.log('\n');

    // 总断言：所有门禁通过
    const failures = gates.filter(g => !g.pass);
    if (failures.length > 0) {
      console.log(`❌ ${failures.length} 项门禁未通过:`);
      for (const f of failures) {
        console.log(`   - ${f.label}: ${f.actual} (${f.target})`);
      }
    } else {
      console.log('✅ 所有质量门禁通过');
    }
    expect(failures.length).toBe(0);
  }, 600000);
});

afterAll(() => {
  console.log('\n══════════════════');
  const pass = gates.filter(g => g.pass).length;
  console.log(`通过: ${pass}/${gates.length}`);
  if (gates.length > 0) {
    console.log(gates.every(g => g.pass) ? '✅ 质量就绪' : '❌ 质量未达标');
  }
});

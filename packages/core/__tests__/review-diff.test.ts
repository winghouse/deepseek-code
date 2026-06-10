import { describe, it, expect } from 'vitest';
import { runReviewDiffPipeline } from '../src/tools/review-diff-pipeline.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execa } from 'execa';

describe('review-diff-pipeline', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscode-diff-'));
    await execa('git', ['init'], { cwd: tmpDir });
    await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    await execa('git', ['config', 'user.name', 'test'], { cwd: tmpDir });
    // 初始提交
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# test\n', 'utf-8');
    await execa('git', ['add', '.'], { cwd: tmpDir });
    await execa('git', ['commit', '-m', 'init'], { cwd: tmpDir });
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('工作区干净时返回空结果', async () => {
    const r = await runReviewDiffPipeline({ workingDir: tmpDir });
    expect(r.success).toBe(true);
    expect(r.changedFiles.length).toBe(0);
  });

  it('检测 .env 文件变更', async () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'OLD', 'utf-8');
    await execa('git', ['add', '.'], { cwd: tmpDir });
    await execa('git', ['commit', '-m', 'add'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, '.env'), 'KEY=secret\n', 'utf-8');
    const r = await runReviewDiffPipeline({ workingDir: tmpDir });
    expect(r.changedFiles.length).toBeGreaterThan(0);
  });

  it('检测安全模块变更', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'permissions.ts'), 'OLD', 'utf-8');
    await execa('git', ['add', '.'], { cwd: tmpDir });
    await execa('git', ['commit', '-m', 'add'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'src', 'permissions.ts'), 'export {}', 'utf-8');
    const r = await runReviewDiffPipeline({ workingDir: tmpDir });
    expect(r.changedFiles.length).toBeGreaterThan(0);
  });

  it('检测配置文件变更', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"old":true}', 'utf-8');
    await execa('git', ['add', '.'], { cwd: tmpDir });
    await execa('git', ['commit', '-m', 'add'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"new":true}', 'utf-8');
    const r = await runReviewDiffPipeline({ workingDir: tmpDir });
    expect(r.changedFiles.length).toBeGreaterThan(0);
  });

  it('删除测试文件标记为高风险', async () => {
    fs.writeFileSync(path.join(tmpDir, 'app.test.ts'), 'test("x",()=>{})', 'utf-8');
    await execa('git', ['add', '.'], { cwd: tmpDir });
    await execa('git', ['commit', '-m', 'add test'], { cwd: tmpDir });
    fs.unlinkSync(path.join(tmpDir, 'app.test.ts'));
    const r = await runReviewDiffPipeline({ workingDir: tmpDir });
    expect(r.stats.testFilesDeleted).toBeGreaterThan(0);
  });
});

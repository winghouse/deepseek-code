import { describe, it, expect } from 'vitest';
import { scanRepo } from '../src/context/scanner.js';
import * as path from 'node:path';

import * as fs from 'node:fs';
const PROJECT_ROOT = process.cwd();

describe('scanRepo — 当前项目', () => {
  it('项目扫描返回非空结果', async () => {
    const repo = await scanRepo({ workingDir: PROJECT_ROOT });
    expect(repo.name).toBeTruthy();
    expect(repo.techStack.language).toBeTruthy();
    expect(repo.techStack.language).not.toBe('Unknown');
    expect(repo.structure.keyDirectories.length).toBeGreaterThan(0);
  });

  it('检测到包管理器', async () => {
    const repo = await scanRepo({ workingDir: PROJECT_ROOT });
    // pnpm-workspace.yaml 存在 → 应为 pnpm
    if (fs.existsSync(path.join(PROJECT_ROOT, 'pnpm-workspace.yaml'))) {
      expect(repo.techStack.packageManager).toBe('pnpm');
    }
  });

  it('检测到 packages 目录', async () => {
    const repo = await scanRepo({ workingDir: PROJECT_ROOT });
    // 项目根有 packages/ 目录
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'packages'))).toBe(true);
    expect(repo.name).toBeTruthy();
  });

  it('缓存命中', async () => {
    await scanRepo({ workingDir: PROJECT_ROOT });
    const start = Date.now();
    const repo = await scanRepo({ workingDir: PROJECT_ROOT });
    // 缓存命中应极快
    expect(Date.now() - start).toBeLessThan(200);
    expect(repo.techStack.language).toBeTruthy();
  });
});

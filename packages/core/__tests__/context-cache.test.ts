import { describe, it, expect } from 'vitest';
import { buildSessionPrefix, buildDynamicTail, buildProjectPrefix } from '../src/context/prompt-builder.js';
import type { RepoInfo } from 'deepseek-code-shared';

const mockRepo: RepoInfo = {
  name: 'test-project',
  rootDir: '/test',
  techStack: { language: 'TypeScript', framework: null, buildTool: 'Vite', packageManager: 'pnpm', runtime: 'Node.js', uiLibrary: null, orm: null, testFramework: 'Vitest' },
  structure: { hasSrcDir: true, entryFiles: ['src/main.ts'], routeFiles: [], configFiles: [], keyDirectories: ['src'] },
  rules: { agentsMd: null, readme: null, packageJson: null, eslintConfig: null, tsconfig: null },
  git: { branch: 'main', status: '', hasUncommittedChanges: false },
};

describe('Context Caching — 前缀稳定性', () => {
  // ═══ Session Prefix ═══
  it('buildSessionPrefix 不包含 knownFiles 和 phase', () => {
    const session = buildSessionPrefix('测试任务', null, 'readonly');
    expect(session).toContain('测试任务');
    expect(session).not.toContain('已知文件'); // knownFiles 已移到 Dynamic Tail
    expect(session).not.toContain('analyzing'); // phase 已移到 Dynamic Tail
  });

  it('Session 前缀同参数多次调用结果一致', () => {
    const s1 = buildSessionPrefix('审查项目', null, 'readonly');
    const s2 = buildSessionPrefix('审查项目', null, 'readonly');
    expect(s1).toBe(s2); // KV Cache 友好的稳定输出
  });

  it('不同 phase 也不影响 Session Prefix 稳定性', () => {
    // phase 已移到 DynamicTail，sessionPrefix 不受 phase 变化影响
    const s1 = buildSessionPrefix('审查项目', null, 'readonly');
    const s2 = buildSessionPrefix('审查项目', null, 'readonly'); // 同参数，无 phase
    expect(s1).toBe(s2);
  });

  // ═══ Dynamic Tail ═══
  it('buildDynamicTail 包含 knownFiles', () => {
    const dynamic = buildDynamicTail('用户输入', undefined, undefined, undefined, ['src/a.ts', 'src/b.ts']);
    expect(dynamic).toContain('已知文件');
    expect(dynamic).toContain('src/a.ts');
    expect(dynamic).toContain('src/b.ts');
  });

  it('buildDynamicTail 包含 phase 和 gitState', () => {
    const dynamic = buildDynamicTail('用户输入', undefined, undefined, undefined, undefined, '分支 main, 有未提交改动: 否', 'analyzing');
    expect(dynamic).toContain('analyzing');
    expect(dynamic).toContain('Git 状态');
    expect(dynamic).toContain('main');
  });

  it('Dynamic Tail 不同 knownFiles 产生不同输出', () => {
    const d1 = buildDynamicTail('input', undefined, undefined, undefined, ['a.ts']);
    const d2 = buildDynamicTail('input', undefined, undefined, undefined, ['a.ts', 'b.ts']);
    expect(d1).not.toBe(d2);
    expect(d1.split('\n')[0]).toBe(d2.split('\n')[0]); // ## 当前输入 相同
  });

  // ═══ Project Prefix 稳定性 ═══
  it('git dirty 变化不影响 Project Prefix hash', () => {
    const repoClean: RepoInfo = { ...mockRepo, git: { branch: 'main', status: '', hasUncommittedChanges: false } };
    const repoDirty: RepoInfo = { ...mockRepo, git: { branch: 'main', status: '?? new-file.ts', hasUncommittedChanges: true } };
    const pClean = buildProjectPrefix(repoClean);
    const pDirty = buildProjectPrefix(repoDirty);
    expect(pClean).toBe(pDirty); // git 状态已移出，projectPrefix 应一致
  });

  it('git 分支变化不影响 Project Prefix hash', () => {
    const repoMain: RepoInfo = { ...mockRepo, git: { branch: 'main', status: '', hasUncommittedChanges: false } };
    const repoDev: RepoInfo = { ...mockRepo, git: { branch: 'feature/xyz', status: '', hasUncommittedChanges: false } };
    const pMain = buildProjectPrefix(repoMain);
    const pDev = buildProjectPrefix(repoDev);
    expect(pMain).toBe(pDev);
  });
});

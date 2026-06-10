import { describe, it, expect } from 'vitest';
import { buildGlobalPrefix, buildProjectPrefix, stableStringify, buildPrompt } from '../src/context/prompt-builder.js';
import type { RepoInfo } from 'deepseek-code-shared';

const mockRepo: RepoInfo = {
  name: 'test-project',
  rootDir: '/test',
  techStack: { language: 'TypeScript', framework: 'React', buildTool: 'Vite', packageManager: 'pnpm', runtime: 'Node.js', uiLibrary: 'Tailwind CSS', orm: null, testFramework: 'Vitest' },
  structure: { hasSrcDir: true, entryFiles: ['src/main.tsx', 'src/App.tsx'], routeFiles: ['src/pages/'], configFiles: ['vite.config.ts'], keyDirectories: ['src', 'src/components', 'src/pages'] },
  rules: { agentsMd: '# Rules\nno console.log', readme: '# Readme', packageJson: {}, eslintConfig: null, tsconfig: null },
  git: { branch: 'main', status: '', hasUncommittedChanges: false },
};

describe('buildGlobalPrefix', () => {
  it('每次生成内容一致', () => {
    const a = buildGlobalPrefix();
    const b = buildGlobalPrefix();
    expect(a).toBe(b); // 内容一致
  });

  it('包含关键字段', () => {
    const p = buildGlobalPrefix();
    expect(p).toContain('DeepSeek Code Agent');
    expect(p).toContain('read_file');
    expect(p).toContain('安全规则');
    // 不包含动态内容
    expect(p).not.toContain('token');
    expect(p).not.toContain('耗时');
  });

  it('不包含时间、sessionId', () => {
    const p = buildGlobalPrefix();
    expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(p).not.toMatch(/session-/);
  });
});

describe('buildProjectPrefix', () => {
  it('同 repo 返回一致', () => {
    const a = buildProjectPrefix(mockRepo);
    const b = buildProjectPrefix(mockRepo);
    expect(a).toBe(b);
  });

  it('目录列表已排序', () => {
    const p = buildProjectPrefix(mockRepo);
    const idx1 = p.indexOf('src/');
    const idx2 = p.indexOf('src/components/');
    const idx3 = p.indexOf('src/pages/');
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it('包含 Git 状态', () => {
    const p = buildProjectPrefix(mockRepo);
    expect(p).toContain('main');
  });
});

describe('stableStringify', () => {
  it('key 排序稳定', () => {
    const a = stableStringify({ z: 1, a: 2, m: 3 });
    const b = stableStringify({ m: 3, a: 2, z: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  it('嵌套对象排序', () => {
    const obj = { b: { z: 1, a: 2 }, a: 1 };
    expect(stableStringify(obj)).toBe('{"a":1,"b":{"a":2,"z":1}}');
  });

  it('数组不变序', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('buildPrompt', () => {
  it('返回四层和 hash', () => {
    const result = buildPrompt({
      repoInfo: mockRepo,
      task: '分析项目',
      plan: null,
      phase: 'analyzing',
      knownFiles: ['a.ts', 'b.ts'],
      mode: 'readonly',
      userInput: '分析项目',
    });
    expect(result.layers.globalPrefix).toBeTruthy();
    expect(result.layers.projectPrefix).toBeTruthy();
    expect(result.layers.sessionPrefix).toBeTruthy();
    expect(result.layers.dynamicTail).toBeTruthy();
    expect(result.hashes.globalPrefixHash).toHaveLength(8);
    expect(result.hashes.projectPrefixHash).toHaveLength(8);
  });

  it('同 repo 同参数 → project/session hash 一致', () => {
    const a = buildPrompt({
      repoInfo: mockRepo,
      task: '分析项目', plan: null, phase: 'analyzing',
      knownFiles: ['a.ts'], mode: 'readonly', userInput: '分析',
    });
    const b = buildPrompt({
      repoInfo: mockRepo,
      task: '分析项目', plan: null, phase: 'analyzing',
      knownFiles: ['a.ts'], mode: 'readonly', userInput: '分析',
    });
    expect(a.hashes.projectPrefixHash).toBe(b.hashes.projectPrefixHash);
    expect(a.hashes.sessionPrefixHash).toBe(b.hashes.sessionPrefixHash);
  });
});

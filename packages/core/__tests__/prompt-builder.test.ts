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

  it('不包含 Git 状态（已移到 Dynamic Tail）', () => {
    const p = buildProjectPrefix(mockRepo);
    expect(p).not.toContain('Git:');
    expect(p).not.toContain('分支');
    expect(p).not.toContain('有未提交改动');
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

  it('knownFiles 变化 → 仅 dynamicTail hash 变化', () => {
    const a = buildPrompt({ repoInfo: mockRepo, task: '分析', plan: null, phase: 'analyzing', knownFiles: ['a.ts'], mode: 'readonly', userInput: '分析' });
    const b = buildPrompt({ repoInfo: mockRepo, task: '分析', plan: null, phase: 'analyzing', knownFiles: ['a.ts', 'b.ts'], mode: 'readonly', userInput: '分析' });
    expect(a.hashes.projectPrefixHash).toBe(b.hashes.projectPrefixHash);
    expect(a.hashes.sessionPrefixHash).toBe(b.hashes.sessionPrefixHash);
    expect(a.hashes.dynamicTailHash).not.toBe(b.hashes.dynamicTailHash);
  });

  it('phase 变化 → sessionPrefix hash 不变', () => {
    const a = buildPrompt({ repoInfo: mockRepo, task: '分析', plan: null, phase: 'analyzing', knownFiles: ['a.ts'], mode: 'readonly', userInput: '分析' });
    const b = buildPrompt({ repoInfo: mockRepo, task: '分析', plan: null, phase: 'verifying', knownFiles: ['a.ts'], mode: 'readonly', userInput: '分析' });
    expect(a.hashes.sessionPrefixHash).toBe(b.hashes.sessionPrefixHash);
    // phase 进入 dynamicTail，所以 dynamicTail 会变
    expect(a.hashes.dynamicTailHash).not.toBe(b.hashes.dynamicTailHash);
  });

  it('git dirty 变化 → projectPrefix hash 不变', () => {
    const cleanRepo = { ...mockRepo, git: { branch: 'main', status: '', hasUncommittedChanges: false } };
    const dirtyRepo = { ...mockRepo, git: { branch: 'main', status: '?? new.ts', hasUncommittedChanges: true } };
    const a = buildPrompt({ repoInfo: cleanRepo, task: '分析', plan: null, phase: 'analyzing', knownFiles: ['a.ts'], mode: 'readonly', userInput: '分析' });
    const b = buildPrompt({ repoInfo: dirtyRepo, task: '分析', plan: null, phase: 'analyzing', knownFiles: ['a.ts'], mode: 'readonly', userInput: '分析' });
    expect(a.hashes.projectPrefixHash).toBe(b.hashes.projectPrefixHash);
  });
});

// ═══ 中文编码验证 ═══
describe('buildGlobalPrefix 中文编码', () => {
  it('包含关键中文字符串，无乱码', () => {
    const p = buildGlobalPrefix();
    expect(p).toContain('你是 DeepSeek Code Agent');
    expect(p).toContain('报告分级标准');
    expect(p).toContain('事实锚定铁律');
    expect(p).not.toContain('浣犳槸');
    expect(p).not.toContain('æ');
  });

  it('所有中文关键字可正常读取', () => {
    const p = buildGlobalPrefix();
    const chineseKeywords = ['工具协议', '安全规则', '输出格式', '事实锚定铁律', '报告分级标准'];
    for (const kw of chineseKeywords) {
      expect(p).toContain(kw);
    }
  });
});

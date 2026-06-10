import { describe, it, expect } from 'vitest';
import { parsePlanJson } from '../src/agent/planner.js';
import type { RepoInfo } from 'deepseek-code-shared';

const mockRepo: RepoInfo = {
  name: 'test',
  rootDir: '/test',
  techStack: { language: 'TypeScript', framework: null, buildTool: 'npm scripts', packageManager: 'pnpm', runtime: 'Node.js', uiLibrary: null, orm: null, testFramework: null },
  structure: { hasSrcDir: true, entryFiles: ['index.ts'], routeFiles: [], configFiles: [], keyDirectories: ['src'] },
  rules: { agentsMd: null, readme: null, packageJson: null, eslintConfig: null, tsconfig: null },
};

describe('parsePlanJson', () => {
  it('解析标准格式 {steps: [{order, action, description}]}', () => {
    const json = `{"steps": [{"order": 1, "action": "read", "description": "读取文件"}]}`;
    const plan = parsePlanJson(json, 'test', mockRepo);
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].order).toBe(1);
    expect(plan.steps[0].description).toBe('读取文件');
  });

  it('解析嵌套格式 {plan: {steps: [...]}}', () => {
    const json = `{"plan": {"title": "修复计划", "steps": [{"order": 1, "action": "search", "description": "搜索代码"}]}}`;
    const plan = parsePlanJson(json, 'test', mockRepo);
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].description).toBe('搜索代码');
  });

  it('解析数组格式 [{step, title}]', () => {
    const json = `[{"step": "1", "title": "分析项目结构", "action": "read"}, {"step": "2", "title": "搜索关键代码", "action": "search"}]`;
    const plan = parsePlanJson(json, 'test', mockRepo);
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan.steps[0].description).toBe('分析项目结构');
    expect(plan.steps[1].description).toBe('搜索关键代码');
  });

  it('解析 plan 为数组格式 {plan: [{step, title, description}]}', () => {
    const json = `{"plan": [{"step": "1", "title": "定位文件", "description": "找到入口文件"}]}`;
    const plan = parsePlanJson(json, 'test', mockRepo);
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].description).toBe('找到入口文件');
  });

  it('使用 description 字段（优先级高于 title）', () => {
    const json = `{"steps": [{"order": 1, "action": "read", "title": "短标题", "description": "更详细描述"}]}`;
    const plan = parsePlanJson(json, 'test', mockRepo);
    // 取最长的字符串字段作为 description
    expect(plan.steps[0].description).toBe('更详细描述');
  });

  it('中文 action 映射', () => {
    const json = `{"steps": [{"action": "读取", "description": "测试"}]}`;
    const plan = parsePlanJson(json, 'test', mockRepo);
    expect(plan.steps[0].action).toBe('read');
  });

  it('缺少 steps 字段时降级', () => {
    const json = `{"taskDescription": "修复一个登录页面的bug", "complexity": "simple"}`;
    const plan = parsePlanJson(json, 'test', mockRepo);
    expect(plan.taskDescription).toBe('修复一个登录页面的bug');
    expect(plan.complexity).toBe('simple');
  });

  it('畸形的 JSON 用降级计划', () => {
    const json = `这不是 JSON`;
    const plan = parsePlanJson(json, 'test', mockRepo);
    expect(plan.complexity).toBe('medium');
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it('markdown 代码块包裹的 JSON', () => {
    const json = '```json\n{"steps": [{"order": 1, "action": "read", "description": "读"}]}\n```';
    const plan = parsePlanJson(json, 'test', mockRepo);
    expect(plan.steps.length).toBe(1);
  });
});

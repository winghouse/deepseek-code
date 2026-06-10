import { describe, it, expect } from 'vitest';
import { getTemplates, generateAgentsMdTemplate } from '../src/templates.js';

describe('templates', () => {
  it('getTemplates 包含 7 个模板', () => {
    const tmpl = getTemplates();
    const names = Object.keys(tmpl);
    expect(names.length).toBe(6);
    expect(names).toContain('nextjs');
    expect(names).toContain('vue3');
    expect(names).toContain('react');
    expect(names).toContain('express');
    expect(names).toContain('python-fastapi');
  });

  it('每个模板包含技术栈', () => {
    const tmpl = getTemplates();
    for (const [name, content] of Object.entries(tmpl)) {
      expect(content).toContain('技术栈');
      expect(content.length).toBeGreaterThan(100);
    }
  });

  it('generateAgentsMdTemplate 生成默认模板', () => {
    const t = generateAgentsMdTemplate();
    expect(t).toContain('# AGENTS.md');
    expect(t).toContain('项目概述');
    expect(t).toContain('技术栈');
    expect(t).toContain('编码规范');
    expect(t).toContain('npm test');
  });
});

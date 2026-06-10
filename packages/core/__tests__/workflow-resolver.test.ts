// ============================================================
// 模板变量解析测试
// ============================================================

import { describe, it, expect } from 'vitest';
import { resolveTemplate, resolveObject } from '../src/workflow/resolver.js';

describe('resolveTemplate', () => {
  const input = {
    name: 'test-project',
    count: 42,
    debug: true,
  };

  const nodeResults: Record<string, { output?: unknown }> = {
    search_1: { output: { results: [{ url: 'https://a.com' }, { url: 'https://b.com' }], total: 2 } },
    read_file: { output: { content: 'Hello World\nLine 2\nLine 3', filePath: '/src/app.ts' } },
    audit: { output: { findings: [{ severity: 'high', title: 'bug1' }], count: 1 } },
    empty_node: { output: null },
  };

  // ---- 基本替换 ----
  describe('基本替换', () => {
    it('${input.name} → "test-project"', () => {
      expect(resolveTemplate('${input.name}', input, nodeResults)).toBe('test-project');
    });
    it('${input.count} → "42"', () => {
      expect(resolveTemplate('${input.count}', input, nodeResults)).toBe('42');
    });
    it('${input.debug} → "true"', () => {
      expect(resolveTemplate('${input.debug}', input, nodeResults)).toBe('true');
    });
    it('多个变量同时替换', () => {
      expect(resolveTemplate('${input.name} has ${input.count} items', input, nodeResults))
        .toBe('test-project has 42 items');
    });
  });

  // ---- 节点结果替换 ----
  describe('节点结果替换', () => {
    it('${search_1.result} → JSON 序列化', () => {
      const result = resolveTemplate('${search_1.result}', input, nodeResults);
      const parsed = JSON.parse(result);
      expect(parsed.total).toBe(2);
      expect(parsed.results).toHaveLength(2);
    });
    it('${search_1.result.total} → "2"', () => {
      expect(resolveTemplate('${search_1.result.total}', input, nodeResults)).toBe('2');
    });
    it('${search_1.result.results[0].url} → 第一个 URL', () => {
      expect(resolveTemplate('${search_1.result.results[0].url}', input, nodeResults))
        .toBe('https://a.com');
    });
    it('${read_file.result.content} → 文件内容', () => {
      const result = resolveTemplate('${read_file.result.content}', input, nodeResults);
      expect(result).toContain('Hello World');
    });
    it('${read_file.result.filePath} → "/src/app.ts"', () => {
      expect(resolveTemplate('${read_file.result.filePath}', input, nodeResults))
        .toBe('/src/app.ts');
    });
  });

  // ---- 嵌套路径 ----
  describe('嵌套路径', () => {
    it('${audit.result.findings[0].severity} → "high"', () => {
      expect(resolveTemplate('${audit.result.findings[0].severity}', input, nodeResults))
        .toBe('high');
    });
    it('${audit.result.findings[0].title} → "bug1"', () => {
      expect(resolveTemplate('${audit.result.findings[0].title}', input, nodeResults))
        .toBe('bug1');
    });
    it('${audit.result.count} → "1"', () => {
      expect(resolveTemplate('${audit.result.count}', input, nodeResults)).toBe('1');
    });
  });

  // ---- 边界情况 ----
  describe('边界情况', () => {
    it('不存在的输入 key → 空字符串', () => {
      expect(resolveTemplate('${input.nonexistent}', input, nodeResults)).toBe('');
    });
    it('不存在的节点 → 空字符串', () => {
      expect(resolveTemplate('${nonexistent.result}', input, nodeResults)).toBe('');
    });
    it('节点输出为 null → 空字符串', () => {
      expect(resolveTemplate('${empty_node.result}', input, nodeResults)).toBe('');
    });
    it('无模板变量的纯文本 → 原样返回', () => {
      expect(resolveTemplate('hello world', input, nodeResults)).toBe('hello world');
    });
    it('浅层路径到标量', () => {
      expect(resolveTemplate('${search_1.result.total}', input, nodeResults)).toBe('2');
    });
    it('深层路径不存在 → 空字符串', () => {
      expect(resolveTemplate('${search_1.result.nonexistent.deep}', input, nodeResults)).toBe('');
    });
  });

  // ---- 截断 ----
  describe('截断保护', () => {
    it('超长内容截断并标记 [TRUNCATED]', () => {
      // 构造一个超长字符串超过 MAX_TEMPLATE_VALUE_LENGTH (8000)
      const long = 'x'.repeat(9000);
      const nodes = { big_node: { output: { text: long } } };
      const result = resolveTemplate('${big_node.result.text}', input, nodes);
      expect(result.length).toBeLessThan(long.length);
      expect(result).toContain('[TRUNCATED]');
    });
  });
});

describe('resolveObject', () => {
  const input = { name: 'test' };
  const nodeResults = {
    step1: { output: { value: 42, status: 'ok' } },
  };

  it('对象中的字符串模板变量', () => {
    const obj = { prompt: '项目 ${input.name} 的结果是 ${step1.result.value}' };
    const result = resolveObject(obj, input, nodeResults);
    expect(result.prompt).toBe('项目 test 的结果是 42');
  });

  it('递归解析嵌套对象', () => {
    const obj = {
      name: '${input.name}',
      nested: { value: '${step1.result.status}' },
    };
    const result = resolveObject(obj, input, nodeResults);
    expect(result.name).toBe('test');
    expect((result as any).nested.value).toBe('ok');
  });

  it('数组中的模板变量', () => {
    const arr = ['${input.name}', '${step1.result.value}'];
    const result = resolveObject(arr, input, nodeResults);
    expect(result).toEqual(['test', '42']);
  });

  it('非字符串原样返回', () => {
    expect(resolveObject(123, input, nodeResults)).toBe(123);
    expect(resolveObject(null, input, nodeResults)).toBe(null);
    expect(resolveObject(true, input, nodeResults)).toBe(true);
  });
});

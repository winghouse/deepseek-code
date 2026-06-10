import { describe, it, expect } from 'vitest';
import { MODEL_PRO, MODEL_FLASH } from '../src/types.js';
import { estimateTaskComplexity, recommendModel, generateSessionId, isSensitiveFile, truncate } from '../src/utils.js';

describe('estimateTaskComplexity', () => {
  it('简单任务返回 simple', () => {
    expect(estimateTaskComplexity('改文案')).toBe('simple');
    expect(estimateTaskComplexity('改颜色')).toBe('simple');
    expect(estimateTaskComplexity('调整间距')).toBe('simple');
  });

  it('复杂任务返回 complex', () => {
    expect(estimateTaskComplexity('重构整个认证模块')).toBe('complex');
    expect(estimateTaskComplexity('数据库迁移升级')).toBe('complex');
    expect(estimateTaskComplexity('新增模块权限系统')).toBe('complex');
  });

  it('普通任务返回 medium', () => {
    expect(estimateTaskComplexity('新增一个按钮')).toBe('medium');
    expect(estimateTaskComplexity('修复首页按钮跳转')).toBe('medium');
    expect(estimateTaskComplexity('修复一个拼写错误')).toBe('medium');
  });
});

describe('recommendModel', () => {
  it('简单任务推荐 flash', () => {
    expect(recommendModel('simple')).toBe(MODEL_FLASH);
  });

  it('中等和复杂任务推荐 pro', () => {
    expect(recommendModel('medium')).toBe(MODEL_PRO);
    expect(recommendModel('complex')).toBe(MODEL_PRO);
  });
});

describe('generateSessionId', () => {
  it('生成以 session- 开头的 ID', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^session-\d{8}-\d{6}-[a-z0-9]{6}$/);
  });

  it('每次生成不同的 ID', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe('isSensitiveFile', () => {
  it('.env 文件是敏感文件', () => {
    expect(isSensitiveFile('.env')).toBe(true);
    expect(isSensitiveFile('.env.local')).toBe(true);
  });

  it('密钥文件是敏感文件', () => {
    expect(isSensitiveFile('id_rsa')).toBe(true);
    expect(isSensitiveFile('server.key')).toBe(true);
    expect(isSensitiveFile('credentials.json')).toBe(true);
  });

  it('普通文件不是敏感文件', () => {
    expect(isSensitiveFile('package.json')).toBe(false);
    expect(isSensitiveFile('src/index.ts')).toBe(false);
    expect(isSensitiveFile('README.md')).toBe(false);
  });
});

describe('truncate', () => {
  it('短文本不截断', () => {
    expect(truncate('hello', 100)).toBe('hello');
  });

  it('长文本截断', () => {
    const long = 'x'.repeat(1000);
    const result = truncate(long, 50);
    expect(result.length).toBeLessThan(80);
    expect(result).toContain('截断');
  });
});

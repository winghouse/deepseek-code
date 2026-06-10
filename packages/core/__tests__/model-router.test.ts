import { describe, it, expect } from 'vitest';
import { estimateTaskComplexity, recommendModel } from 'deepseek-code-shared';
import { MODEL_PRO, MODEL_FLASH } from 'deepseek-code-shared';

describe('ModelRouter — 模型选择', () => {
  it('简单任务推荐 Flash', () => {
    expect(recommendModel('simple')).toBe(MODEL_FLASH);
  });

  it('中等任务推荐 Pro', () => {
    expect(recommendModel('medium')).toBe(MODEL_PRO);
  });

  it('复杂任务推荐 Pro', () => {
    expect(recommendModel('complex')).toBe(MODEL_PRO);
  });

  it('estimateTaskComplexity 识别简单任务', () => {
    expect(estimateTaskComplexity('改文案')).toBe('simple');
    expect(estimateTaskComplexity('加注释')).toBe('simple');
    expect(estimateTaskComplexity('改颜色')).toBe('simple');
  });

  it('estimateTaskComplexity 识别复杂任务', () => {
    expect(estimateTaskComplexity('重构整个认证系统')).toBe('complex');
    expect(estimateTaskComplexity('数据库迁移')).toBe('complex');
  });

  it('estimateTaskComplexity 默认 medium', () => {
    expect(estimateTaskComplexity('分析这个文件的功能')).toBe('medium');
  });
});

// ============================================================
// DeepSeek Code — 共享工具函数
// ============================================================

import { statSync } from 'node:fs';
import { MODEL_PRO, MODEL_FLASH } from './types.js';

/**
 * 判断任务复杂度
 * 简单任务 → flash，复杂任务 → pro
 */
export function estimateTaskComplexity(task: string): 'simple' | 'medium' | 'complex' {
  const complexKeywords = [
    '重构', 'refactor', '多文件', '架构', '性能优化', '安全漏洞',
    '数据库迁移', '升级', '迁移', '大改', '重新设计', '新增模块',
    '权限系统', '认证', '支付', '工作流', '多人协作',
  ];
  const simpleKeywords = [
    '改文案', '改颜色', '调整间距', '加注释',
    '删除console', '修复类型错误', 'lint', 'format',
    '加一个简单的', '改一个变量名', '小改', '补注释',
    '修改一个', '改一处', '修复拼写',
  ];

  const hasComplex = complexKeywords.some((k) => task.includes(k));
  const hasSimple = simpleKeywords.some((k) => task.includes(k));

  if (hasComplex && !hasSimple) return 'complex';
  if (hasSimple && !hasComplex) return 'simple';
  return 'medium';
}

/**
 * 根据复杂度决定推荐模型
 */
export function recommendModel(complexity: 'simple' | 'medium' | 'complex'): typeof MODEL_FLASH | typeof MODEL_PRO {
  return complexity === 'simple' ? MODEL_FLASH : MODEL_PRO;
}

/**
 * 生成唯一 session ID
 */
export function generateSessionId(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const random = Math.random().toString(36).slice(2, 8);
  return `session-${dateStr}-${timeStr}-${random}`;
}

/**
 * 安全截断文本
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + `\n\n... (已截断 ${text.length - maxLength} 字符)`;
}

// 路由逻辑已迁移到 core 包的 Hybrid Router: deepseek-code-core agent/router.ts

/**
 * 判断路径是否为敏感文件
 */
export function isSensitiveFile(filePath: string): boolean {
  const sensitivePatterns = [
    /\.env$/,
    /\.env\./,
    /\.secret/,
    /credentials\./,
    /\.pem$/,
    /id_rsa/,
    /\.key$/,
    /\.token/,
  ];
  return sensitivePatterns.some((p) => p.test(filePath));
}

/** 文件指纹 (mtime:size)，用于检测文件变化 */
export function fileFingerprint(filePath: string): string {
  try {
    const stat = statSync(filePath);
    return `${stat.mtimeMs.toFixed(0)}:${stat.size}`;
  } catch {
    return '';
  }
}

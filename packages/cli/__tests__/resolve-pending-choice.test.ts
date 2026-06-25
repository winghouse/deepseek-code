// ============================================================
// resolvePendingChoice 测试 — 短回复解析矩阵
// ============================================================

import { describe, it, expect } from 'vitest';
import { resolvePendingChoice } from '../src/resolve-pending-choice.js';
import type { PendingChoice } from '../src/resolve-pending-choice.js';

const CHOICES_3: PendingChoice[] = [
  { id: '1', label: '继续分析代码安全性' },
  { id: '2', label: '生成测试用例' },
  { id: '3', label: '输出报告' },
];

const CHOICES_5: PendingChoice[] = [
  { id: '1', label: '选项A' },
  { id: '2', label: '选项B' },
  { id: '3', label: '选项C' },
  { id: '4', label: '选项D' },
  { id: '5', label: '选项E' },
];

describe('resolvePendingChoice', () => {
  // ═══ 数字 ═══
  describe('数字输入', () => {
    it('"1" → 第1个', () => {
      const r = resolvePendingChoice('1', CHOICES_3);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(0);
      expect(r!.label).toBe('继续分析代码安全性');
    });

    it('"01" → 第1个', () => {
      const r = resolvePendingChoice('01', CHOICES_3);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(0);
    });

    it('"2" → 第2个', () => {
      const r = resolvePendingChoice('2', CHOICES_3);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(1);
      expect(r!.label).toBe('生成测试用例');
    });

    it('"3" → 第3个', () => {
      const r = resolvePendingChoice('3', CHOICES_3);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(2);
    });

    it('"5" in 5 choices → 第5个', () => {
      const r = resolvePendingChoice('5', CHOICES_5);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(4);
      expect(r!.label).toBe('选项E');
    });

    it('"0" → null (越界)', () => {
      const r = resolvePendingChoice('0', CHOICES_3);
      expect(r).toBeNull();
    });

    it('"4" in 3 choices → null (越界)', () => {
      const r = resolvePendingChoice('4', CHOICES_3);
      expect(r).toBeNull();
    });

    it('"6" in 5 choices → null (越界)', () => {
      const r = resolvePendingChoice('6', CHOICES_5);
      expect(r).toBeNull();
    });
  });

  // ═══ 中文数字 ═══
  describe('中文数字输入', () => {
    it('"一" → 第1个', () => {
      const r = resolvePendingChoice('一', CHOICES_3);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(0);
    });

    it('"二" → 第2个', () => {
      const r = resolvePendingChoice('二', CHOICES_3);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(1);
    });

    it('"五" in 5 choices → 第5个', () => {
      const r = resolvePendingChoice('五', CHOICES_5);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(4);
    });

    it('"六" → null (不在映射中)', () => {
      const r = resolvePendingChoice('六', CHOICES_3);
      expect(r).toBeNull();
    });
  });

  // ═══ 第X项 ═══
  describe('"第X项" 输入', () => {
    it('"第一项" → 第1个', () => {
      const r = resolvePendingChoice('第一项', CHOICES_3);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(0);
    });

    it('"第二项" → 第2个', () => {
      const r = resolvePendingChoice('第二项', CHOICES_3);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(1);
    });

    it('"第三项" → 第3个', () => {
      const r = resolvePendingChoice('第三项', CHOICES_3);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(2);
    });

    it('"第五项" in 5 choices → 第5个', () => {
      const r = resolvePendingChoice('第五项', CHOICES_5);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(4);
    });

    it('"第六项" → null (不在映射中)', () => {
      const r = resolvePendingChoice('第六项', CHOICES_5);
      expect(r).toBeNull();
    });
  });

  // ═══ 边界 & 拒识 ═══
  describe('拒识 & 边界', () => {
    it('空字符串 → null', () => {
      expect(resolvePendingChoice('', CHOICES_3)).toBeNull();
      expect(resolvePendingChoice('  ', CHOICES_3)).toBeNull();
    });

    it('"继续" → null', () => {
      expect(resolvePendingChoice('继续', CHOICES_3)).toBeNull();
    });

    it('"abc" → null', () => {
      expect(resolvePendingChoice('abc', CHOICES_3)).toBeNull();
    });

    it('choices 为空数组 → null', () => {
      expect(resolvePendingChoice('1', [])).toBeNull();
    });

    it('前后空格 → 归一化后正常匹配', () => {
      const r = resolvePendingChoice(' 1 ', CHOICES_3);
      expect(r).not.toBeNull();
      expect(r!.index).toBe(0);
    });
  });
});

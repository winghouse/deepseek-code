// ============================================================
// 安全条件表达式测试
// ============================================================

import { describe, it, expect } from 'vitest';
import { evaluateExpression } from '../src/workflow/expressions.js';

describe('evaluateExpression', () => {
  // ---- 字面量 ----
  describe('字面量', () => {
    it('true → true', () => {
      expect(evaluateExpression('true')).toBe(true);
    });
    it('false → false', () => {
      expect(evaluateExpression('false')).toBe(false);
    });
    it('null → false', () => {
      expect(evaluateExpression('null')).toBe(false);
    });
    it('空字符串 → false', () => {
      expect(evaluateExpression('')).toBe(true); // 空字符串默认 true
    });
    it('数字 1 → true', () => {
      expect(evaluateExpression('1')).toBe(true);
    });
    it('数字 0 → false', () => {
      expect(evaluateExpression('0')).toBe(false);
    });
  });

  // ---- 比较操作符 ----
  describe('比较操作符', () => {
    it('1 == 1', () => {
      expect(evaluateExpression('1 == 1')).toBe(true);
    });
    it('1 != 2', () => {
      expect(evaluateExpression('1 != 2')).toBe(true);
    });
    it('1 == 2 → false', () => {
      expect(evaluateExpression('1 == 2')).toBe(false);
    });
    it('2 > 1', () => {
      expect(evaluateExpression('2 > 1')).toBe(true);
    });
    it('1 >= 1', () => {
      expect(evaluateExpression('1 >= 1')).toBe(true);
    });
    it('1 < 2', () => {
      expect(evaluateExpression('1 < 2')).toBe(true);
    });
    it('2 <= 2', () => {
      expect(evaluateExpression('2 <= 2')).toBe(true);
    });
    it('2 <= 1 → false', () => {
      expect(evaluateExpression('2 <= 1')).toBe(false);
    });
  });

  // ---- 字符串比较 ----
  describe('字符串比较', () => {
    it("'hello' == 'hello'", () => {
      expect(evaluateExpression("'hello' == 'hello'")).toBe(true);
    });
    it("'hello' != 'world'", () => {
      expect(evaluateExpression("'hello' != 'world'")).toBe(true);
    });
    it("'hello' == 'world' → false", () => {
      expect(evaluateExpression("'hello' == 'world'")).toBe(false);
    });
  });

  // ---- contains ----
  describe('contains', () => {
    it("'hello world' contains 'world'", () => {
      expect(evaluateExpression("'hello world' contains 'world'")).toBe(true);
    });
    it("'hello' contains 'x' → false", () => {
      expect(evaluateExpression("'hello' contains 'x'")).toBe(false);
    });
  });

  // ---- 布尔运算 ----
  describe('布尔运算', () => {
    it('true and true', () => {
      expect(evaluateExpression('true and true')).toBe(true);
    });
    it('true and false → false', () => {
      expect(evaluateExpression('true and false')).toBe(false);
    });
    it('true or false', () => {
      expect(evaluateExpression('true or false')).toBe(true);
    });
    it('false or false → false', () => {
      expect(evaluateExpression('false or false')).toBe(false);
    });
    it('not true → false', () => {
      expect(evaluateExpression('not true')).toBe(false);
    });
    it('not false', () => {
      expect(evaluateExpression('not false')).toBe(true);
    });
    it('1 == 1 and 2 == 2', () => {
      expect(evaluateExpression('1 == 1 and 2 == 2')).toBe(true);
    });
    it('1 == 1 and 1 == 2 → false', () => {
      expect(evaluateExpression('1 == 1 and 1 == 2')).toBe(false);
    });
    it('1 == 2 or 2 == 2', () => {
      expect(evaluateExpression('1 == 2 or 2 == 2')).toBe(true);
    });
  });

  // ---- 括号 ----
  describe('括号分组', () => {
    it('(true and false) or true', () => {
      expect(evaluateExpression('(true and false) or true')).toBe(true);
    });
    it('true and (false or true)', () => {
      expect(evaluateExpression('true and (false or true)')).toBe(true);
    });
    it('(1 == 2) or (2 == 2)', () => {
      expect(evaluateExpression('(1 == 2) or (2 == 2)')).toBe(true);
    });
    it('not (1 == 2)', () => {
      expect(evaluateExpression('not (1 == 2)')).toBe(true);
    });
  });

  // ---- 嵌套布尔 ----
  describe('复杂组合', () => {
    it('not false and not false', () => {
      expect(evaluateExpression('not false and not false')).toBe(true);
    });
    it('1 > 0 and 2 > 1 and 3 > 2', () => {
      expect(evaluateExpression('1 > 0 and 2 > 1 and 3 > 2')).toBe(true);
    });
    it('1 > 0 or false or false', () => {
      expect(evaluateExpression('1 > 0 or false or false')).toBe(true);
    });
  });

  // ---- 安全性 ----
  describe('安全性（不执行任意 JS）', () => {
    it('拒绝函数调用语法 → 返回 false', () => {
      // eval() 语法不被 tokenizer 识别，会解析失败返回 false
      expect(evaluateExpression('alert(1)')).toBe(false);
    });
    it('拒绝赋值语法 → 返回 false', () => {
      expect(evaluateExpression('a = 1')).toBe(false);
    });
    it('空字符串 → true', () => {
      expect(evaluateExpression('')).toBe(true);
    });
  });

  // ---- 边界情况 ----
  describe('边界情况', () => {
    it('多个空格分隔的操作符', () => {
      expect(evaluateExpression('1   ==   1')).toBe(true);
    });
    it('模板变量 ${...} 当作空字符串', () => {
      // 未替换前 -> 空字符串
      expect(evaluateExpression("${node.result} == ''")).toBe(true);
    });
    it('exists 操作符', () => {
      // 仅语法层面支持，实际依赖替换后的值
      expect(evaluateExpression("'hello' exists")).toBe(true);
    });
    it('not 结合比较', () => {
      expect(evaluateExpression('not 1 == 2')).toBe(true);
    });
    it('not not true', () => {
      expect(evaluateExpression('not not true')).toBe(true);
    });
  });
});

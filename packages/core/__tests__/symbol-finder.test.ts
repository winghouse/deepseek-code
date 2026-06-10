import { describe, it, expect } from 'vitest';
import { findSymbolReferencesAST, toToolResult } from '../src/tools/symbol-finder.js';

describe('symbol-finder — AST 符号查找', () => {
  it('查找实际存在的符号', () => {
    const r = findSymbolReferencesAST('ModelName', process.cwd());
    expect(r.success).toBe(true);
    expect(r.totalCount).toBeGreaterThan(0);
    // 应至少包含 declaration
    const decl = r.references.find((ref) => ref.kind === 'declaration');
    expect(decl).toBeDefined();
  });

  it('查找不存在的符号返回空', () => {
    const r = findSymbolReferencesAST('NonExistentSymbol_XYZ999', process.cwd());
    expect(r.success).toBe(true);
    expect(r.totalCount).toBe(0);
  });

  it('非 TS 标识符降级文本搜索', () => {
    const r = findSymbolReferencesAST('.test.', process.cwd());
    expect(r.success).toBe(true);
    expect(r.astBased).toBe(false); // 文本搜索降级
  });

  it('toToolResult 格式正确', () => {
    const r = findSymbolReferencesAST('UserIntent', process.cwd());
    const tr = toToolResult(r);
    expect(tr.success).toBe(true);
    expect(tr.metadata?.exists).toBe(true);
    expect(Array.isArray(tr.metadata?.references)).toBe(true);
  });
});

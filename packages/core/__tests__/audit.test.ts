import { describe, it, expect } from 'vitest';
import { auditTools } from '../src/tools/audit-tools.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('readJsonPath', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscode-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('package.json $.scripts 返回 type=object', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }), 'utf-8');
    const at = auditTools(tmpDir);
    const r = at.readJsonPath('package.json', '$.scripts');
    expect(r.success).toBe(true);
    expect(r.metadata?.type).toBe('object');
  });

  it('不存在字段返回 exists=false', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }), 'utf-8');
    const at = auditTools(tmpDir);
    const r = at.readJsonPath('package.json', '$.scripts.build');
    expect(r.metadata?.exists).toBe(false);
  });
});

describe('listScripts', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscode-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('返回 type=object 和所有 scripts', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', clean: 'rm -rf dist' } }), 'utf-8');
    const at = auditTools(tmpDir);
    const r = at.listScripts();
    expect(r.success).toBe(true);
    expect((r.metadata as any).type).toBe('object');
    expect((r.metadata as any).keys).toContain('clean');
  });
});

describe('detectCrossPlatform', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscode-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('检测到 rm -rf 标记为跨平台风险', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { clean: 'rm -rf dist' } }), 'utf-8');
    const at = auditTools(tmpDir);
    const r = at.detectCrossPlatform();
    expect((r.metadata as any).issueCount).toBeGreaterThan(0);
  });

  it('无风险命令时返回 0', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }), 'utf-8');
    const at = auditTools(tmpDir);
    const r = at.detectCrossPlatform();
    expect((r.metadata as any).issueCount).toBe(0);
  });
});

describe('findReferences — AST 符号查找', () => {
  it('AST 查找 MCPToolRegistration', () => {
    const at = auditTools(process.cwd());
    const r = at.findReferences('MCPToolRegistration');
    expect(r.success).toBe(true);
    const meta = r.metadata as Record<string, unknown>;
    // 至少找到 1 处引用（如果 tsconfig 可用，使用 AST；否则降级为文本搜索）
    expect(meta.exists).toBe(true);
    expect((meta.referenceCount as number)).toBeGreaterThanOrEqual(1);
    // metadata 包含结构化引用信息
    expect(meta.references).toBeDefined();
    expect(Array.isArray(meta.references)).toBe(true);
  });

  it('AST 查找不存在的符号返回空', () => {
    const at = auditTools(process.cwd());
    const r = at.findReferences('NonExistentSymbolXYZ999');
    expect(r.success).toBe(true);
    const meta = r.metadata as Record<string, unknown>;
    expect(meta.exists).toBe(false);
    expect(meta.referenceCount).toBe(0);
  });

  it('AST 查找 RouteDecision 类型', () => {
    const at = auditTools(process.cwd());
    const r = at.findReferences('RouteDecision');
    expect(r.success).toBe(true);
    const meta = r.metadata as Record<string, unknown>;
    expect(meta.exists).toBe(true);
    // 结构化引用应有 kind 字段
    const refs = meta.references as Array<Record<string, unknown>>;
    if (refs && refs.length > 0) {
      expect(refs[0]).toHaveProperty('file');
      expect(refs[0]).toHaveProperty('line');
      expect(refs[0]).toHaveProperty('kind');
    }
  });
});

describe('verifyFinding', () => {
  it('有 evidence → verified', () => {
    const at = auditTools(process.cwd());
    const f = { id: 'T1', title: 'test', category: 'config' as const, severity: 'low' as const, claim: 'x', evidence: [{ file: 'package.json', tool: 'file_exists' as const }], verificationStatus: 'unverified' as const, confidence: 0.5 };
    const r = at.verifyFinding(f);
    expect(r.verificationStatus).toBe('verified');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('无 evidence → unverified', () => {
    const at = auditTools(process.cwd());
    const f = { id: 'T2', title: 'test', category: 'config' as const, severity: 'low' as const, claim: 'x', evidence: [], verificationStatus: 'unverified' as const, confidence: 0.5 };
    const r = at.verifyFinding(f);
    expect(r.verificationStatus).toBe('unverified');
    expect(r.confidence).toBeLessThan(0.5);
  });
});

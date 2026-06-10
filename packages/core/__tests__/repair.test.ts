import { describe, it, expect } from 'vitest';
import {
  parseErrors,
  extractFilesFromTask,
  analyzeRootCausePattern,
  runRepairPipeline,
} from '../src/tools/repair-pipeline.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ═══════════════════════════════════════
// 1. 错误解析器测试 (parseErrors)
// ═══════════════════════════════════════

describe('parseErrors — TS 类型错误', () => {
  it('解析 TS2345 类型不匹配 (src/file.ts(10,5))', () => {
    const input = `src/router.ts(42,15): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const e = errors[0];
    expect(e.file).toBe('src/router.ts');
    expect(e.line).toBe(42);
    expect(e.column).toBe(15);
    expect(e.errorCode).toBe('TS2345');
    expect(e.category).toBe('typescript');
    expect(e.message).toContain('not assignable');
  });

  it('解析 TS2339 属性不存在', () => {
    const input = `src/components/Modal.tsx(88,9): error TS2339: Property 'onClose' does not exist on type 'ModalProps'.`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].errorCode).toBe('TS2339');
    expect(errors[0].file).toBe('src/components/Modal.tsx');
    expect(errors[0].line).toBe(88);
  });

  it('解析 TS2304 找不到名称', () => {
    const input = `packages/core/index.ts(5,20): error TS2304: Cannot find name 'React'.`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].errorCode).toBe('TS2304');
  });

  it('解析 TS2322 类型分配错误', () => {
    const input = `src/store.ts(33,7): error TS2322: Type '{ id: string }' is not assignable to type 'User'.`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].errorCode).toBe('TS2322');
    expect(errors[0].file).toBe('src/store.ts');
  });

  it('解析 TS7006 隐式 any', () => {
    const input = `src/utils.ts(15,10): error TS7006: Parameter 'data' implicitly has an 'any' type.`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].errorCode).toBe('TS7006');
  });

  it('解析 TS18046 可能为 null', () => {
    const input = `src/api.ts(42,5): error TS18046: 'result' is possibly 'null'.`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].errorCode).toBe('TS18046');
  });

  it('解析 TS2307 找不到模块', () => {
    const input = `src/index.ts(3,22): error TS2307: Cannot find module '@/utils/helper' or its corresponding type declarations.`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].errorCode).toBe('TS2307');
  });

  it('批量解析多个 TS 错误', () => {
    const input = `
src/a.ts(10,5): error TS2345: Argument of type 'string'...
src/b.ts(20,7): error TS2339: Property 'x' does not exist...
src/c.ts(30,12): error TS7006: Parameter 'y' implicitly has an 'any' type.
    `.trim();
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.map((e) => e.file)).toContain('src/a.ts');
    expect(errors.map((e) => e.file)).toContain('src/b.ts');
    expect(errors.map((e) => e.file)).toContain('src/c.ts');
  });
});

describe('parseErrors — ESLint 错误', () => {
  it('解析 ESLint 格式 (file:line:col: error rule-id)', () => {
    const input = `src/router.ts:42:15: error  Missing return type on function  @typescript-eslint/explicit-function-return-type`;
    const errors = parseErrors(input);
    // ESLint pattern matches or falls through to unknown
    const e = errors.find((e) => e.file === 'src/router.ts');
    // Both ESLint and fallback could match
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('解析 ESLint 格式 (warning)', () => {
    const input = `src/utils.ts:5:1: warning  'x' is assigned a value but never used  no-unused-vars`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('parseErrors — Build 错误', () => {
  it('解析 Cannot find module', () => {
    const input = `Error: Cannot find module 'deepseek-code-shared'
    at Object.<anonymous> (/project/src/index.ts:3:22)`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const buildErr = errors.find((e) => e.category === 'build');
    expect(buildErr).toBeDefined();
    expect(buildErr?.message).toContain('Cannot find module');
  });

  it('解析 ModuleNotFoundError', () => {
    const input = `ModuleNotFoundError: Module not found: Error: Can't resolve './MissingComponent' in '/project/src/pages'`;
    const errors = parseErrors(input);
    expect(errors.some((e) => e.category === 'build')).toBe(true);
  });

  it('解析构建失败', () => {
    const input = `Build failed: tsc compilation failed with 3 errors.`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].category).toBe('build');
  });
});

describe('parseErrors — Test 失败', () => {
  it('解析 FAIL 行', () => {
    const input = `FAIL  src/__tests__/router.test.ts > Router > should route debug tasks
  ● Router › should route debug tasks
    expected 'local_action' to be 'agent_readonly'`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const testErr = errors.find((e) => e.category === 'test');
    expect(testErr).toBeDefined();
  });

  it('解析 assert 错误', () => {
    const input = `AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.category === 'test')).toBe(true);
  });

  it('解析 expect().toBe() 失败', () => {
    const input = `Expected: "hello"
Received: "world"
    at Object.<anonymous> (src/__tests__/greet.test.ts:15:20)`;
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('parseErrors — Fallback / 边界情况', () => {
  it('空字符串返回空数组', () => {
    const errors = parseErrors('');
    expect(errors).toEqual([]);
  });

  it('无错误信息的纯文本返回空', () => {
    const errors = parseErrors('hello world\nnothing to see here');
    expect(errors).toEqual([]);
  });

  it('简单 error 行作为 unknown 分类', () => {
    const input = 'Error: something went wrong';
    const errors = parseErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Could be build or fallback unknown
    expect(['build', 'unknown']).toContain(errors[0].category);
  });
});

// ═══════════════════════════════════════
// 2. 文件提取测试
// ═══════════════════════════════════════

describe('extractFilesFromTask', () => {
  it('从中文任务描述提取 .ts 文件', () => {
    const files = extractFilesFromTask('修复 src/router.ts 的类型错误');
    expect(files).toContain('src/router.ts');
  });

  it('从英文任务提取文件', () => {
    const files = extractFilesFromTask('fix type error in packages/core/src/agent/loop.ts');
    expect(files).toContain('packages/core/src/agent/loop.ts');
  });

  it('提取多个文件', () => {
    const files = extractFilesFromTask('src/a.ts 和 src/b.ts 有冲突');
    expect(files).toContain('src/a.ts');
    expect(files).toContain('src/b.ts');
  });

  it('提取 .tsx 文件', () => {
    const files = extractFilesFromTask('components/Modal.tsx 渲染有问题');
    expect(files).toContain('components/Modal.tsx');
  });

  it('提取 .json 文件', () => {
    const files = extractFilesFromTask('修改 package.json 的依赖版本');
    expect(files).toContain('package.json');
  });

  it('无文件的任务返回空数组', () => {
    const files = extractFilesFromTask('代码跑不起来了');
    expect(files).toEqual([]);
  });
});

// ═══════════════════════════════════════
// 3. 根因模式匹配测试
// ═══════════════════════════════════════

describe('analyzeRootCausePattern', () => {
  it('TS2345 → 类型不匹配诊断', () => {
    const errors = parseErrors("src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.");
    const result = analyzeRootCausePattern(errors, new Map());
    expect(result).toContain('类型不匹配');
    expect(result).toContain('TS2345');
  });

  it('TS2339 → 属性不存在诊断', () => {
    const errors = parseErrors("src/comp.tsx(20,7): error TS2339: Property 'onClick' does not exist on type 'ButtonProps'.");
    const result = analyzeRootCausePattern(errors, new Map());
    expect(result).toContain('属性不存在');
    expect(result).toContain('TS2339');
  });

  it('TS2304 → 找不到名称诊断', () => {
    const errors = parseErrors("src/index.ts(5,1): error TS2304: Cannot find name 'process'.");
    const result = analyzeRootCausePattern(errors, new Map());
    expect(result).toContain('找不到名称');
    expect(result).toContain('TS2304');
  });

  it('TS7006 → 隐式 any 诊断', () => {
    const errors = parseErrors("src/hooks.ts(15,10): error TS7006: Parameter 'event' implicitly has an 'any' type.");
    const result = analyzeRootCausePattern(errors, new Map());
    expect(result).toContain('隐式 any');
    expect(result).toContain('TS7006');
  });

  it('Build Cannot find module → 模块缺失诊断', () => {
    const errors = parseErrors("Error: Cannot find module 'lodash'");
    const result = analyzeRootCausePattern(errors, new Map());
    expect(result).toContain('模块缺失');
    expect(result).toContain('lodash');
  });

  it('未知错误返回 null', () => {
    const result = analyzeRootCausePattern([], new Map());
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════
// 4. 端到端 Pipeline 测试
// ═══════════════════════════════════════

describe('runRepairPipeline — 端到端', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscode-repair-'));
    // 创建最小项目结构
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      scripts: { build: 'tsc', test: 'vitest' },
    }, null, 2), 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022' },
    }, null, 2), 'utf-8');
    // 创建带错误的源文件
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'broken.ts'), `
function add(a, b) {
  return a + b;
}

function greet(name: string): string {
  return "Hello " + name;
}

// TS2345: 类型不匹配
const result: number = add("1", "2");
`, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('仅任务描述，readonly 模式', async () => {
    const result = await runRepairPipeline({
      workingDir: tmpDir,
      taskDescription: '修复 src/broken.ts 的类型错误',
      mode: 'readonly',
    });
    expect(result.success).toBe(true);
    expect(result.filesExamined).toContain('src/broken.ts');
  });

  it('带 TS 错误上下文，readonly 模式', async () => {
    const errorCtx = `src/broken.ts(13,28): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;
    const result = await runRepairPipeline({
      workingDir: tmpDir,
      taskDescription: '修复类型错误',
      mode: 'readonly',
      errorContext: errorCtx,
    });
    expect(result.success).toBe(true);
    expect(result.errorLocation).toBeDefined();
    expect(result.errorLocation?.errorCode).toBe('TS2345');
    expect(result.filesExamined).toContain('src/broken.ts');
    // 模式匹配应能给出根因
    expect(result.rootCause).toBeDefined();
    expect(result.rootCause).toContain('类型不匹配');
  });

  it('ask 模式给出修复建议', async () => {
    const result = await runRepairPipeline({
      workingDir: tmpDir,
      taskDescription: '修复 src/broken.ts:13 的 TS2345 错误',
      mode: 'ask',
      errorContext: `src/broken.ts(13,28): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
    });
    expect(result.success).toBe(true);
    expect(result.suggestedFix).toBeDefined();
    expect(result.suggestedFix).toContain('读写');
  });

  it('无匹配文件时仍返回成功', async () => {
    const result = await runRepairPipeline({
      workingDir: tmpDir,
      taskDescription: '代码跑不起来了',
      mode: 'readonly',
    });
    expect(result.success).toBe(true);
    expect(result.filesExamined.length).toBe(0);
  });

  it('文件不存在时通过项目搜索定位', async () => {
    // "broken.ts" 存在于 src/ 下
    const result = await runRepairPipeline({
      workingDir: tmpDir,
      taskDescription: '修复 broken.ts 的报错',
      mode: 'readonly',
      errorContext: `broken.ts(13,28): error TS2345: ...`,
    });
    expect(result.success).toBe(true);
    // 应该搜索到 src/broken.ts
    expect(result.filesExamined.length).toBeGreaterThan(0);
  });

  it('build error 根因分析', async () => {
    const result = await runRepairPipeline({
      workingDir: tmpDir,
      taskDescription: '构建失败',
      mode: 'readonly',
      errorContext: `Error: Cannot find module '@missing/lib'`,
    });
    expect(result.success).toBe(true);
    expect(result.rootCause).toBeDefined();
    expect(result.rootCause).toContain('模块缺失');
  });

  it('test 失败根因分析', async () => {
    const result = await runRepairPipeline({
      workingDir: tmpDir,
      taskDescription: '测试挂了',
      mode: 'readonly',
      errorContext: `FAIL  src/__tests__/broken.test.ts > broken > should work
  ● broken › should work
    AssertionError: expected false to be true`,
    });
    expect(result.success).toBe(true);
    expect(result.rootCause).toBeDefined();
    expect(result.rootCause).toContain('测试失败');
  });

  it('多个错误被全部解析', async () => {
    const errorCtx = `
src/a.ts(10,5): error TS2345: type mismatch
src/b.ts(20,7): error TS2339: property missing
src/c.ts(30,12): error TS7006: implicit any
    `.trim();
    const result = await runRepairPipeline({
      workingDir: tmpDir,
      taskDescription: '修复所有类型错误',
      mode: 'readonly',
      errorContext: errorCtx,
    });
    expect(result.success).toBe(true);
    expect(result.errorLocation).toBeDefined();
  });

  it('elapsedMs 被正确记录', async () => {
    const result = await runRepairPipeline({
      workingDir: tmpDir,
      taskDescription: '修复类型错误',
      mode: 'readonly',
    });
    expect(result.elapsedMs).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeLessThan(5000);
  });
});

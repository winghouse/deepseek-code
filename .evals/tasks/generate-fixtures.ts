// ============================================================
// 生成 20 个真实任务 fixture repo
// 用法: npx tsx .evals/tasks/generate-fixtures.ts
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

interface FixtureSpec {
  suite: string;
  id: string;
  description: string;
  files: Record<string, string>;
  taskJson: Record<string, unknown>;
}

const SPECS: FixtureSpec[] = [
  // ═══ repair-typescript (6) ═══
  {
    suite: 'repair-typescript', id: 'ts2345-type-mismatch',
    description: 'TS2345: 参数类型不匹配',
    files: {
      'package.json': JSON.stringify({ name: 'ts2345-demo', scripts: { typecheck: 'tsc --noEmit' } }, null, 2),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, outDir: 'dist' }, include: ['src'] }, null, 2),
      'src/app.ts': [
        'function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        '// TS2345: Argument of type string is not assignable to parameter of type number',
        'const result = add("42", 10);',
        '',
        'export { add, result };',
      ].join('\n'),
    },
    taskJson: {
      id: 'repair_ts_001', suite: 'repair-typescript', risk: 'P0',
      task: '修复 src/app.ts 第 6 行的类型错误：Argument of type string is not assignable to parameter of type number',
      mode: 'readonly',
      expected: {
        route: { intent: 'debug_task' },
        mustReadFiles: ['src/app.ts'],
        outputMustContain: ['TS2345', 'string', 'number'],
        outputMustNotContain: [],
        maxToolCalls: 10,
      },
    },
  },
  {
    suite: 'repair-typescript', id: 'ts2339-missing-property',
    description: 'TS2339: 属性不存在',
    files: {
      'package.json': JSON.stringify({ name: 'ts2339-demo', scripts: { typecheck: 'tsc --noEmit' } }, null, 2),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, outDir: 'dist' }, include: ['src'] }, null, 2),
      'src/user.ts': [
        'interface User {',
        '  name: string;',
        '  email: string;',
        '}',
        '',
        'function greet(user: User): string {',
        '  // TS2339: Property age does not exist on type User',
        '  return `${user.name} is ${user.age} years old`;',
        '}',
        '',
        'export { User, greet };',
      ].join('\n'),
    },
    taskJson: {
      id: 'repair_ts_002', suite: 'repair-typescript', risk: 'P0',
      task: '修复 src/user.ts 第 7 行的错误：Property age does not exist on type User',
      mode: 'readonly',
      expected: {
        route: { intent: 'debug_task' },
        mustReadFiles: ['src/user.ts'],
        outputMustContain: ['TS2339', 'User', 'age'],
        outputMustNotContain: [],
        maxToolCalls: 10,
      },
    },
  },
  {
    suite: 'repair-typescript', id: 'ts2304-cannot-find-name',
    description: 'TS2304: 找不到名称',
    files: {
      'package.json': JSON.stringify({ name: 'ts2304-demo', scripts: { typecheck: 'tsc --noEmit' } }, null, 2),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, outDir: 'dist' }, include: ['src'] }, null, 2),
      'src/util.ts': [
        '// Missing import for process.env',
        'function getApiUrl(): string {',
        '  // TS2304: Cannot find name process',
        '  return PROCES.env.API_URL || "https://api.example.com";',
        '}',
        '',
        'export { getApiUrl };',
      ].join('\n'),
    },
    taskJson: {
      id: 'repair_ts_003', suite: 'repair-typescript', risk: 'P1',
      task: '修复 src/util.ts 第 3 行的错误：Cannot find name PROCES',
      mode: 'readonly',
      expected: {
        route: { intent: 'debug_task' },
        mustReadFiles: ['src/util.ts'],
        outputMustContain: ['TS2304', 'PROCES', 'process'],
        outputMustNotContain: [],
        maxToolCalls: 10,
      },
    },
  },
  {
    suite: 'repair-typescript', id: 'ts18047-possibly-null',
    description: 'TS18047: 可能为 null',
    files: {
      'package.json': JSON.stringify({ name: 'ts18047-demo', scripts: { typecheck: 'tsc --noEmit' } }, null, 2),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, outDir: 'dist' }, include: ['src'] }, null, 2),
      'src/dom.ts': [
        'function getTitle(): string {',
        '  const el = document.getElementById("title");',
        '  // TS18047: el is possibly null',
        '  return el.innerHTML;',
        '}',
        '',
        'export { getTitle };',
      ].join('\n'),
    },
    taskJson: {
      id: 'repair_ts_004', suite: 'repair-typescript', risk: 'P1',
      task: '修复 src/dom.ts 第 3 行的错误：el is possibly null',
      mode: 'readonly',
      expected: {
        route: { intent: 'debug_task' },
        mustReadFiles: ['src/dom.ts'],
        outputMustContain: ['null', 'el', 'check'],
        outputMustNotContain: [],
        maxToolCalls: 10,
      },
    },
  },
  {
    suite: 'repair-typescript', id: 'ts6133-unused-variable',
    description: 'TS6133: 未使用变量',
    files: {
      'package.json': JSON.stringify({ name: 'ts6133-demo', scripts: { typecheck: 'tsc --noEmit' } }, null, 2),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, noUnusedLocals: true, outDir: 'dist' }, include: ['src'] }, null, 2),
      'src/data.ts': [
        'function fetchUsers() {',
        '  const unusedVar = "this is never used";',
        '  return [{ name: "Alice" }, { name: "Bob" }];',
        '}',
        '',
        'export { fetchUsers };',
      ].join('\n'),
    },
    taskJson: {
      id: 'repair_ts_005', suite: 'repair-typescript', risk: 'P2',
      task: '修复 src/data.ts 的 lint 警告：unusedVar is declared but never used',
      mode: 'readonly',
      expected: {
        route: { intent: 'debug_task' },
        mustReadFiles: ['src/data.ts'],
        outputMustContain: ['unused', 'remove', 'TS6133'],
        outputMustNotContain: [],
        maxToolCalls: 10,
      },
    },
  },
  {
    suite: 'repair-typescript', id: 'wrong-import-path',
    description: '错误的 import 路径',
    files: {
      'package.json': JSON.stringify({ name: 'import-demo', scripts: { typecheck: 'tsc --noEmit' } }, null, 2),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, outDir: 'dist' }, include: ['src'] }, null, 2),
      'src/helper.ts': [
        'export function formatDate(d: Date): string {',
        '  return d.toISOString();',
        '}',
      ].join('\n'),
      'src/main.ts': [
        '// Wrong import path: should be ./helper',
        'import { formatDate } from "./helpr";',
        '',
        'console.log(formatDate(new Date()));',
      ].join('\n'),
    },
    taskJson: {
      id: 'repair_ts_006', suite: 'repair-typescript', risk: 'P1',
      task: '修复 src/main.ts 的错误：Cannot find module ./helpr',
      mode: 'readonly',
      expected: {
        route: { intent: 'debug_task' },
        mustReadFiles: ['src/main.ts', 'src/helper.ts'],
        outputMustContain: ['import', 'helper', 'helpr'],
        outputMustNotContain: [],
        maxToolCalls: 12,
      },
    },
  },

  // ═══ diff-review (4) ═══
  {
    suite: 'diff-review', id: 'secret-leaked',
    description: 'Git diff 中包含密钥泄露',
    files: {
      'package.json': JSON.stringify({ name: 'secret-leak-demo' }, null, 2),
      'src/config.ts': [
        '// Original',
        'export const API_KEY = "placeholder";',
      ].join('\n'),
      'src/config.secret.ts': [
        '// This file contains the NEW version with leaked secret',
        'export const API_KEY = "sk-abc123def456ghi789jkl";',
      ].join('\n'),
    },
    taskJson: {
      id: 'diff_review_001', suite: 'diff-review', risk: 'P0',
      task: '检查当前 git diff 有没有安全风险',
      mode: 'readonly',
      expected: {
        route: { execution: 'agent_readonly' },
        mustReadFiles: [],
        outputMustContain: ['secret', 'api', 'key'],
        outputMustNotContain: [],
        maxToolCalls: 10,
      },
    },
  },
  {
    suite: 'diff-review', id: 'deleted-test',
    description: 'Git diff 中删除了测试文件',
    files: {
      'package.json': JSON.stringify({ name: 'deleted-test-demo', scripts: { test: 'vitest run' } }, null, 2),
      'src/math.ts': [
        'export function multiply(a: number, b: number): number { return a * b; }',
      ].join('\n'),
      'tests/math.test.ts': [
        'import { multiply } from "../src/math";',
        '// This test file was deleted in the diff',
      ].join('\n'),
    },
    taskJson: {
      id: 'diff_review_002', suite: 'diff-review', risk: 'P0',
      task: '检查当前 git diff，注意有没有测试文件被删除',
      mode: 'readonly',
      expected: {
        route: { execution: 'agent_readonly' },
        mustReadFiles: [],
        outputMustContain: ['test', 'delet'],
        outputMustNotContain: [],
        maxToolCalls: 10,
      },
    },
  },
  {
    suite: 'diff-review', id: 'api-breaking-change',
    description: 'Git diff 中包含 API breaking change',
    files: {
      'package.json': JSON.stringify({ name: 'api-break-demo' }, null, 2),
      'src/api.ts': [
        '// V1: exported function',
        'export function getUser(id: number): { name: string } {',
        '  return { name: "Alice" };',
        '}',
        '',
        '// NEW: removed export of getUser → breaking change',
        'function getUser(id: number, opts?: { detailed: boolean }): { name: string } | null {',
        '  return opts?.detailed ? { name: "Alice" } : null;',
        '}',
      ].join('\n'),
      'src/api.old.ts': [
        '// Original version before breaking change',
        'export function getUser(id: number): { name: string } {',
        '  return { name: "Alice" };',
        '}',
      ].join('\n'),
    },
    taskJson: {
      id: 'diff_review_003', suite: 'diff-review', risk: 'P1',
      task: '检查 diff 中有没有 API breaking change',
      mode: 'readonly',
      expected: {
        route: { execution: 'agent_readonly' },
        mustReadFiles: [],
        outputMustContain: ['export', 'function', 'signature'],
        outputMustNotContain: [],
        maxToolCalls: 10,
      },
    },
  },
  {
    suite: 'diff-review', id: 'clean-diff',
    description: '干净的 diff（无问题）',
    files: {
      'package.json': JSON.stringify({ name: 'clean-demo' }, null, 2),
      'src/lib.ts': [
        'export const VERSION = "1.0.0";',
      ].join('\n'),
    },
    taskJson: {
      id: 'diff_review_004', suite: 'diff-review', risk: 'P2',
      task: '检查 diff',
      mode: 'readonly',
      expected: {
        route: { execution: 'llm_direct' },
        mustReadFiles: [],
        outputMustContain: [],
        outputMustNotContain: [],
        maxToolCalls: 5,
      },
    },
  },

  // ═══ url-docs (3) ═══
  {
    suite: 'url-docs', id: 'valid-docs',
    description: '正常文档页面',
    files: {
      'package.json': JSON.stringify({ name: 'url-docs-demo' }, null, 2),
      'index.html': [
        '<!DOCTYPE html>',
        '<html><head><title>API Reference</title></head>',
        '<body>',
        '<h1>API Reference</h1>',
        '<p>Base URL: <code>https://api.example.com/v1</code></p>',
        '<h2>Authentication</h2>',
        '<p>Include an <code>Authorization: Bearer &lt;token&gt;</code> header.</p>',
        '<h2>Endpoints</h2>',
        '<h3>GET /users</h3>',
        '<p>Returns a list of users.</p>',
        '</body></html>',
      ].join('\n'),
    },
    taskJson: {
      id: 'url_001', suite: 'url-docs', risk: 'P0',
      task: '看下 http://localhost:9999/index.html 的 API 文档内容，总结接入方式',
      mode: 'readonly',
      expected: {
        route: { intent: 'webpage_summary', execution: 'url_fetch_pipeline' },
        mustReadFiles: [],
        outputMustContain: ['API', 'auth', 'endpoint'],
        outputMustNotContain: [],
        maxToolCalls: 5,
      },
    },
  },
  {
    suite: 'url-docs', id: 'dead-link',
    description: '死链（404）',
    files: {
      'package.json': JSON.stringify({ name: 'dead-link-demo' }, null, 2),
    },
    taskJson: {
      id: 'url_002', suite: 'url-docs', risk: 'P1',
      task: '看下 https://example.com/nonexistent-page-404 这个页面',
      mode: 'readonly',
      expected: {
        route: { intent: 'webpage_summary', execution: 'url_fetch_pipeline' },
        mustReadFiles: [],
        outputMustContain: [],
        outputMustNotContain: [],
        maxToolCalls: 5,
      },
    },
  },
  {
    suite: 'url-docs', id: 'spa-page',
    description: 'SPA 页面（JS 渲染，无实质内容）',
    files: {
      'package.json': JSON.stringify({ name: 'spa-demo' }, null, 2),
      'index.html': [
        '<!DOCTYPE html><html><head><title>SPA App</title></head>',
        '<body><div id="root"></div>',
        '<script src="bundle.js"></script></body></html>',
      ].join('\n'),
    },
    taskJson: {
      id: 'url_003', suite: 'url-docs', risk: 'P1',
      task: '看下 http://localhost:9999/spa-index.html 的内容',
      mode: 'readonly',
      expected: {
        route: { intent: 'webpage_summary', execution: 'url_fetch_pipeline' },
        mustReadFiles: [],
        outputMustContain: [],
        outputMustNotContain: [],
        maxToolCalls: 5,
      },
    },
  },

  // ═══ code-review (3) ═══
  {
    suite: 'code-review', id: 'security-eval',
    description: '代码中使用 eval',
    files: {
      'package.json': JSON.stringify({ name: 'security-demo' }, null, 2),
      'src/parser.ts': [
        '// UNSAFE: uses eval',
        'export function parseExpression(expr: string): unknown {',
        '  return eval(expr);',
        '}',
      ].join('\n'),
    },
    taskJson: {
      id: 'review_001', suite: 'code-review', risk: 'P0',
      task: '审查 src/parser.ts 有没有安全问题',
      mode: 'readonly',
      expected: {
        route: { intent: 'audit_task' },
        mustReadFiles: ['src/parser.ts'],
        outputMustContain: ['eval', 'security', 'unsafe'],
        outputMustNotContain: [],
        maxToolCalls: 10,
      },
    },
  },
  {
    suite: 'code-review', id: 'missing-types',
    description: '缺少类型标注',
    files: {
      'package.json': JSON.stringify({ name: 'types-demo', scripts: { typecheck: 'tsc --noEmit' } }, null, 2),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true, outDir: 'dist' }, include: ['src'] }, null, 2),
      'src/service.ts': [
        '// Missing return type and parameter types',
        'function createUser(data) {',
        '  return {',
        '    id: Math.random(),',
        '    ...data,',
        '    createdAt: new Date()',
        '  };',
        '}',
        '',
        'export { createUser };',
      ].join('\n'),
    },
    taskJson: {
      id: 'review_002', suite: 'code-review', risk: 'P1',
      task: '审查 src/service.ts，检查类型安全问题',
      mode: 'readonly',
      expected: {
        route: { intent: 'audit_task' },
        mustReadFiles: ['src/service.ts'],
        outputMustContain: ['type', 'any', 'interface'],
        outputMustNotContain: [],
        maxToolCalls: 10,
      },
    },
  },
  {
    suite: 'code-review', id: 'missing-error-handling',
    description: '缺少错误处理',
    files: {
      'package.json': JSON.stringify({ name: 'error-demo' }, null, 2),
      'src/fetch.ts': [
        '// No error handling',
        'export async function fetchUser(id: number) {',
        '  const res = await fetch(`/api/users/${id}`);',
        '  const data = await res.json();',
        '  return data;',
        '}',
      ].join('\n'),
    },
    taskJson: {
      id: 'review_003', suite: 'code-review', risk: 'P1',
      task: '审查 src/fetch.ts，检查有没有错误处理问题',
      mode: 'readonly',
      expected: {
        route: { intent: 'audit_task' },
        mustReadFiles: ['src/fetch.ts'],
        outputMustContain: ['error', 'try', 'catch', 'status'],
        outputMustNotContain: [],
        maxToolCalls: 10,
      },
    },
  },

  // ═══ resume/pendingAction (2) ═══
  {
    suite: 'resume', id: 'resume-session',
    description: '恢复会话继续之前任务',
    files: {
      'package.json': JSON.stringify({ name: 'resume-demo' }, null, 2),
      'src/code.ts': [
        'export const hello = "world";',
      ].join('\n'),
    },
    taskJson: {
      id: 'resume_001', suite: 'resume', risk: 'P1',
      task: '--resume session-xxx',
      mode: 'readonly',
      expected: {
        route: { intent: 'command_resume', execution: 'local_action' },
        mustReadFiles: [],
        outputMustContain: [],
        outputMustNotContain: [],
        maxToolCalls: 3,
      },
    },
  },
  {
    suite: 'resume', id: 'continue-pending',
    description: '继续未完成的 patch 审核',
    files: {
      'package.json': JSON.stringify({ name: 'pending-demo' }, null, 2),
      'src/target.ts': [
        'function oldFn(a: string) { return a; }',
      ].join('\n'),
    },
    taskJson: {
      id: 'resume_002', suite: 'resume', risk: 'P1',
      task: '继续',
      mode: 'readonly',
      expected: {
        route: { execution: 'llm_direct' },
        mustReadFiles: [],
        outputMustContain: [],
        outputMustNotContain: [],
        maxToolCalls: 3,
      },
    },
  },
];

// ═══ Main ═══

function generateFixtures() {
  if (fs.existsSync(FIXTURES_DIR)) {
    fs.rmSync(FIXTURES_DIR, { recursive: true });
  }
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  let created = 0;
  for (const spec of SPECS) {
    const suiteDir = path.join(FIXTURES_DIR, spec.suite);
    const caseDir = path.join(suiteDir, spec.id);

    fs.mkdirSync(caseDir, { recursive: true });

    // Write files
    for (const [filePath, content] of Object.entries(spec.files)) {
      const fullPath = path.join(caseDir, filePath);
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
    }

    // Write task.json
    fs.writeFileSync(
      path.join(caseDir, 'task.json'),
      JSON.stringify(spec.taskJson, null, 2),
      'utf-8',
    );

    // git init + first commit
    try {
      execSync('git init', { cwd: caseDir, stdio: 'ignore' });
      execSync('git config user.email "eval@dscode.dev"', { cwd: caseDir, stdio: 'ignore' });
      execSync('git config user.name "dscode eval"', { cwd: caseDir, stdio: 'ignore' });
      execSync('git add -A', { cwd: caseDir, stdio: 'ignore' });
      execSync('git commit -m "initial commit"', { cwd: caseDir, stdio: 'ignore' });
    } catch {
      // git not available is ok for eval
    }

    // For diff-review fixtures, make a second commit with the "bad" changes
    if (spec.suite === 'diff-review') {
      try {
        if (spec.id === 'secret-leaked') {
          fs.copyFileSync(
            path.join(caseDir, 'src/config.secret.ts'),
            path.join(caseDir, 'src/config.ts'),
          );
          fs.unlinkSync(path.join(caseDir, 'src/config.secret.ts'));
        } else if (spec.id === 'deleted-test') {
          fs.unlinkSync(path.join(caseDir, 'tests/math.test.ts'));
        } else if (spec.id === 'api-breaking-change') {
          fs.copyFileSync(
            path.join(caseDir, 'src/api.ts'),
            path.join(caseDir, 'src/api.ts'),
          );
          // api.ts already contains the breaking version, delete old
          fs.unlinkSync(path.join(caseDir, 'src/api.old.ts'));
        }
        // clean-diff: no second commit (stays clean)
        if (spec.id !== 'clean-diff') {
          execSync('git add -A', { cwd: caseDir, stdio: 'ignore' });
          execSync('git commit -m "bad change: ' + spec.description + '"', { cwd: caseDir, stdio: 'ignore' });
        }
      } catch { /* ok */ }
    }

    created++;
    console.log(`  ✅ ${spec.suite}/${spec.id}`);
  }

  console.log(`\n🎯 已生成 ${created} 个 fixture repo → ${FIXTURES_DIR}`);
}

generateFixtures();

import { describe, it, expect } from 'vitest';

// 直接测试 applyUnifiedDiff 函数（内部函数，通过 applyPatch 间接测）
// 这里我们通过构造典型 diff 场景来验证
import { createToolExecutors } from '../src/tools/executors.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('applyPatch via createToolExecutors', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `dscode-diff-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('应用简单 unified diff', async () => {
    const original = 'line1\nline2\nline3\nline4\nline5\n';
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, original, 'utf-8');

    const patch = `--- a/test.txt
+++ b/test.txt
@@ -2,3 +2,4 @@
 line2
-line3
+line3_modified
+line3_added
 line4
 line5`;

    const tools = createToolExecutors({ workingDir: tmpDir });
    const result = await tools.applyPatch({
      patch,
      filesAffected: ['test.txt'],
    });

    expect(result.success).toBe(true);
    const modified = fs.readFileSync(filePath, 'utf-8');
    expect(modified).toContain('line3_modified');
    expect(modified).toContain('line3_added');
    expect(modified).not.toContain('line3\n');
  });

  it('应用 SEARCH/REPLACE 格式', async () => {
    const original = 'function add(a, b) {\n  return a + b;\n}\n';
    const filePath = path.join(tmpDir, 'math.ts');
    fs.writeFileSync(filePath, original, 'utf-8');

    const patch = `<<<<<<< SEARCH
function add(a, b) {
  return a + b;
}
=======
function add(a: number, b: number): number {
  return a + b;
}
>>>>>>> REPLACE`;

    const tools = createToolExecutors({ workingDir: tmpDir });
    const result = await tools.applyPatch({
      patch,
      filesAffected: ['math.ts'],
    });

    expect(result.success).toBe(true);
    const modified = fs.readFileSync(filePath, 'utf-8');
    expect(modified).toContain('number');
    expect(modified).toContain(': number');
  });

  it('新文件创建', async () => {
    const patch = `--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,3 @@
+export const hello = 'world';
+export function greet() {
+  return 'hello';
+}`;

    const tools = createToolExecutors({ workingDir: tmpDir });
    const result = await tools.applyPatch({
      patch,
      filesAffected: ['newfile.ts'],
    });

    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'newfile.ts'), 'utf-8');
    expect(content).toContain("hello = 'world'");
  });

  it('apply_patch 自动从 patch 提取文件名', async () => {
    const original = 'hello world\n';
    const filePath = path.join(tmpDir, 'auto.ts');
    fs.writeFileSync(filePath, original, 'utf-8');

    // 不传 filesAffected，从 patch 自动提取
    const patch = `--- a/auto.ts\n+++ b/auto.ts\n@@ -1 +1 @@\n-hello world\n+hello deepseek\n`;
    const tools = createToolExecutors({ workingDir: tmpDir });
    const result = await tools.applyPatch({ patch } as { patch: string; filesAffected?: string[] });

    expect(result.success).toBe(true);
    const modified = fs.readFileSync(filePath, 'utf-8');
    expect(modified).toContain('hello deepseek');
  });

  it('多 hunk patch', async () => {
    const original = 'line1\nline2\nline3\nline4\nline5\n';
    const filePath = path.join(tmpDir, 'multi.txt');
    fs.writeFileSync(filePath, original, 'utf-8');

    const patch = `--- a/multi.txt
+++ b/multi.txt
@@ -1,2 +1,3 @@
 line1
 line2
+line2_extra
@@ -4,2 +5,2 @@
 line4
-line5
+line5_changed`;

    const tools = createToolExecutors({ workingDir: tmpDir });
    const result = await tools.applyPatch({
      patch,
      filesAffected: ['multi.txt'],
    });

    expect(result.success).toBe(true);
    const modified = fs.readFileSync(filePath, 'utf-8');
    expect(modified).toContain('line2_extra');
    expect(modified).toContain('line5_changed');
  });
});

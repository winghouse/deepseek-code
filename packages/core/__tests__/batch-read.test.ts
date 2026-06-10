import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createToolExecutors } from '../src/tools/executors.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('read_file_batch — V4 1M 上下文', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscode-batch-'));
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export const a = 1;\n'.repeat(50), 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'export const b = 2;\n'.repeat(30), 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'c.ts'), 'export const c = 3;\n'.repeat(10), 'utf-8');
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('批量读取多个文件', async () => {
    const tools = createToolExecutors({ workingDir: tmpDir });
    const result = await tools.readFileBatch({ filePaths: ['a.ts', 'b.ts'], maxLinesPerFile: 5 });
    expect(result.success).toBe(true);
    expect(result.content).toContain('a.ts');
    expect(result.content).toContain('b.ts');
    expect(result.content).toContain('export const a');
    expect(result.content).toContain('export const b');
  });

  it('不存在的文件不阻塞', async () => {
    const tools = createToolExecutors({ workingDir: tmpDir });
    const result = await tools.readFileBatch({ filePaths: ['a.ts', 'notexist.ts'] });
    expect(result.success).toBe(true);
    expect(result.metadata?.filesRead).toBe(1);
    expect(result.metadata?.filesFailed).toBe(1);
  });

  it('默认 maxLinesPerFile 200', async () => {
    const tools = createToolExecutors({ workingDir: tmpDir });
    const result = await tools.readFileBatch({ filePaths: ['c.ts'] });
    expect(result.success).toBe(true);
    expect(result.content.split('\n').length).toBeLessThan(20); // c.ts has 10 lines
  });
});

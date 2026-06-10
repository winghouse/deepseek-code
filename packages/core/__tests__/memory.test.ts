import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MODEL_PRO } from 'deepseek-code-shared';
import { InMemoryStore, FileMemoryStore, createStep } from '../src/context/memory.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Session } from 'deepseek-code-shared';

function createTestSession(id: string): Session {
  return {
    id,
    createdAt: new Date(),
    taskDescription: '测试任务',
    modelName: MODEL_PRO,
    workingDir: '/test',
    steps: [],
    completed: false,
  };
}

describe('InMemoryStore', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('保存和加载会话', async () => {
    const session = createTestSession('test-1');
    await store.saveSession(session);
    const loaded = await store.loadSession('test-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.taskDescription).toBe('测试任务');
  });

  it('不存在的会话返回 null', async () => {
    const loaded = await store.loadSession('nonexistent');
    expect(loaded).toBeNull();
  });

  it('列出所有会话', async () => {
    await store.saveSession(createTestSession('s1'));
    await store.saveSession(createTestSession('s2'));
    await store.saveSession(createTestSession('s3'));

    const list = await store.listSessions();
    expect(list.length).toBe(3);
  });

  it('删除会话', async () => {
    await store.saveSession(createTestSession('s1'));
    await store.deleteSession('s1');
    const loaded = await store.loadSession('s1');
    expect(loaded).toBeNull();
  });
});

describe('FileMemoryStore', () => {
  let tmpDir: string;
  let store: FileMemoryStore;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `dscode-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = new FileMemoryStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('保存会话到文件', async () => {
    const session = createTestSession('file-test-1');
    await store.saveSession(session);

    const sessionDir = path.join(tmpDir, '.deepseek-code', 'sessions');
    expect(fs.existsSync(path.join(sessionDir, 'file-test-1.json'))).toBe(true);
  });

  it('从文件加载会话', async () => {
    const session = createTestSession('file-test-2');
    await store.saveSession(session);

    const loaded = await store.loadSession('file-test-2');
    expect(loaded).not.toBeNull();
    expect(loaded!.modelName).toBe(MODEL_PRO);
  });

  it('列出文件会话', async () => {
    await store.saveSession(createTestSession('f1'));
    await store.saveSession(createTestSession('f2'));

    const list = await store.listSessions();
    expect(list.length).toBe(2);
  });
});

describe('createStep', () => {
  it('创建一个步骤', () => {
    const step = createStep(1, 'tool_call', 'read_file: package.json');
    expect(step.index).toBe(1);
    expect(step.type).toBe('tool_call');
    expect(step.content).toContain('package.json');
    expect(step.timestamp).toBeInstanceOf(Date);
  });
});

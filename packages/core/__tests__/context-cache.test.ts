import { describe, it, expect } from 'vitest';
import { buildSessionPrefix, buildDynamicTail } from '../src/context/prompt-builder.js';

describe('Context Caching — Session 前缀稳定性', () => {
  it('buildSessionPrefix 不包含 knownFiles', () => {
    const session = buildSessionPrefix('测试任务', null, 'analyzing', 'readonly');
    expect(session).toContain('测试任务');
    expect(session).toContain('analyzing');
    expect(session).not.toContain('已知文件'); // knownFiles 已移到 Dynamic Tail
  });

  it('buildDynamicTail 包含 knownFiles', () => {
    const dynamic = buildDynamicTail('用户输入', undefined, undefined, undefined, ['src/a.ts', 'src/b.ts']);
    expect(dynamic).toContain('已知文件');
    expect(dynamic).toContain('src/a.ts');
    expect(dynamic).toContain('src/b.ts');
  });

  it('Session 前缀同任务同阶段多次调用结果一致', () => {
    const s1 = buildSessionPrefix('审查项目', null, 'analyzing', 'readonly');
    const s2 = buildSessionPrefix('审查项目', null, 'analyzing', 'readonly');
    expect(s1).toBe(s2); // KV Cache 友好的稳定输出
  });

  it('Dynamic Tail 不同 knownFiles 产生不同输出', () => {
    const d1 = buildDynamicTail('input', undefined, undefined, undefined, ['a.ts']);
    const d2 = buildDynamicTail('input', undefined, undefined, undefined, ['a.ts', 'b.ts']);
    expect(d1).not.toBe(d2);
    // 但 common prefix 保持稳定（前两行相同）
    expect(d1.split('\n')[0]).toBe(d2.split('\n')[0]); // ## 当前输入 相同
  });
});

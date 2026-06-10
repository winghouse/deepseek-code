import { describe, it, expect } from 'vitest';
import { MODEL_PRO, MODEL_FLASH } from 'deepseek-code-shared';
import type { ChatOptions } from '../src/model/types.js';

describe('DeepSeekClient — 模型配置', () => {
  it('MODEL_PRO 常量正确', () => {
    expect(MODEL_PRO).toBe('deepseek-v4-pro');
  });

  it('MODEL_FLASH 常量正确', () => {
    expect(MODEL_FLASH).toBe('deepseek-v4-flash');
  });

  it('模型名用作类型正确', () => {
    const model: typeof MODEL_PRO | typeof MODEL_FLASH = MODEL_PRO;
    expect(model).toBe('deepseek-v4-pro');
  });

  it('DeepSeekConfig 可以有自定义 baseUrl', () => {
    const cfg = { apiKey: 'sk-test', baseUrl: 'https://custom.api.com', timeout: 60000 };
    expect(cfg.baseUrl).toBe('https://custom.api.com');
    expect(cfg.timeout).toBe(60000);
  });
});

describe('Function Strict — tool_choice', () => {
  it('toolChoice 支持 required', () => {
    const opts: ChatOptions = { toolChoice: 'required' };
    expect(opts.toolChoice).toBe('required');
  });

  it('toolChoice 支持 auto', () => {
    const opts: ChatOptions = { toolChoice: 'auto' };
    expect(opts.toolChoice).toBe('auto');
  });

  it('toolChoice 支持强制指定工具', () => {
    const opts: ChatOptions = { toolChoice: { type: 'function', function: { name: 'read_file' } } };
    expect(opts.toolChoice).toEqual({ type: 'function', function: { name: 'read_file' } });
  });
});

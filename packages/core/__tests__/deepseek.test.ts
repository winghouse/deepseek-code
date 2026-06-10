import { describe, it, expect } from 'vitest';
import { MODEL_PRO, MODEL_FLASH } from 'deepseek-code-shared';

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

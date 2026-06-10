import { describe, it, expect } from 'vitest';
import { validateUrl } from '../src/tools/web-search.js';

describe('url-fetch-pipeline — URL 验证', () => {
  it('合法公网 URL 通过', () => {
    expect(validateUrl('https://api-docs.deepseek.com').valid).toBe(true);
    expect(validateUrl('https://github.com/facebook/react').valid).toBe(true);
  });

  it('file:// 被拒绝', () => {
    expect(validateUrl('file:///etc/passwd').valid).toBe(false);
  });

  it('localhost 被拒绝', () => {
    expect(validateUrl('http://localhost:3000/api').valid).toBe(false);
  });

  it('内网 10.x 被拒绝', () => {
    expect(validateUrl('http://10.0.0.1/admin').valid).toBe(false);
  });

  it('内网 192.168.x 被拒绝', () => {
    expect(validateUrl('https://192.168.1.100').valid).toBe(false);
  });

  it('metadata 地址被拒绝', () => {
    expect(validateUrl('http://169.254.169.254/latest').valid).toBe(false);
  });

  it('空 URL 被拒绝', () => {
    expect(validateUrl('').valid).toBe(false);
  });

  it('无效格式被拒绝', () => {
    expect(validateUrl('not-a-url').valid).toBe(false);
  });
});

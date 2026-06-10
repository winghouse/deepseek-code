import { describe, it, expect } from 'vitest';
import { filterSecrets, containsSuspiciousSecrets } from '../src/safety/secret-filter.js';

describe('filterSecrets', () => {
  it('过滤 OpenAI/DeepSeek API Key', () => {
    const input = 'apiKey=sk-abc123def456ghi789jkl012mno345pqr678stu901vwx';
    const result = filterSecrets(input);
    expect(result).not.toContain('sk-abc123');
    expect(result).toContain('REDACTED');
  });

  it('过滤 JWT Token', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = filterSecrets(input);
    expect(result).toContain('REDACTED');
    expect(result).not.toContain('eyJhbGci');
  });

  it('过滤 AWS Access Key', () => {
    const input = 'AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE';
    const result = filterSecrets(input);
    expect(result).toContain('REDACTED');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('过滤私钥', () => {
    const input = '-----BEGIN RSA PRIVATE KEY-----\nsomekeydata\n-----END RSA PRIVATE KEY-----';
    const result = filterSecrets(input);
    expect(result).toContain('REDACTED');
    expect(result).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(result).not.toContain('END RSA PRIVATE KEY');
  });

  it('不过滤普通内容', () => {
    const input = '这是普通文本，包含 package.json 和 tsconfig.json 等信息';
    expect(filterSecrets(input)).toBe(input);
  });
});

describe('containsSuspiciousSecrets', () => {
  it('检测 API Key', () => {
    const { hasSecrets, reasons } = containsSuspiciousSecrets('api_key=sk-abc123def456ghi789jkl');
    expect(hasSecrets).toBe(true);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it('普通内容无密钥', () => {
    const { hasSecrets } = containsSuspiciousSecrets('console.log("hello world")');
    expect(hasSecrets).toBe(false);
  });

  it('检测 JWT', () => {
    const { hasSecrets } = containsSuspiciousSecrets('Bearer eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM.c2lnbmF0dXJl');
    expect(hasSecrets).toBe(true);
  });
});

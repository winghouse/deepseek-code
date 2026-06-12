import { describe, it, expect } from 'vitest';
import { validateUrl } from '../src/tools/web-search.js';

describe('validateUrl — 安全边界', () => {
  it('合法的 https URL', () => {
    expect(validateUrl('https://example.com').valid).toBe(true);
    expect(validateUrl('https://api-docs.deepseek.com/guides').valid).toBe(true);
  });

  it('合法的 http URL', () => {
    expect(validateUrl('http://example.com').valid).toBe(true);
  });

  it('禁止空 URL', () => {
    expect(validateUrl('').valid).toBe(false);
    expect(validateUrl('   ').valid).toBe(false);
  });

  it('禁止超长 URL', () => {
    expect(validateUrl('https://x.com/' + 'a'.repeat(2100)).valid).toBe(false);
  });

  it('禁止 file:// 协议', () => {
    expect(validateUrl('file:///etc/passwd').valid).toBe(false);
  });

  it('禁止 ftp:// 协议', () => {
    expect(validateUrl('ftp://example.com').valid).toBe(false);
  });

  // ═══ localhost 防护 ═══
  it('禁止 localhost', () => {
    expect(validateUrl('http://localhost:3000').valid).toBe(false);
    expect(validateUrl('https://localhost/api').valid).toBe(false);
  });

  it('禁止 127.0.0.1', () => {
    expect(validateUrl('http://127.0.0.1:8080').valid).toBe(false);
  });

  it('禁止 0.0.0.0', () => {
    expect(validateUrl('http://0.0.0.0').valid).toBe(false);
  });

  // ═══ 内网 IPv4 防护 ═══
  it('禁止 10.x 内网', () => {
    expect(validateUrl('http://10.0.0.1').valid).toBe(false);
    expect(validateUrl('https://10.255.255.254/api').valid).toBe(false);
  });

  it('禁止 172.16-31.x 内网', () => {
    expect(validateUrl('http://172.16.0.1').valid).toBe(false);
    expect(validateUrl('http://172.31.255.254').valid).toBe(false);
  });

  it('禁止 192.168.x 内网', () => {
    expect(validateUrl('http://192.168.1.1').valid).toBe(false);
    expect(validateUrl('https://192.168.0.100/admin').valid).toBe(false);
  });

  // ═══ metadata 防护 ═══
  it('禁止 169.254.169.254', () => {
    expect(validateUrl('http://169.254.169.254/latest/meta-data').valid).toBe(false);
  });
  it('禁止 169.254.0.0/16 全段 (如 169.254.10.1)', () => {
    expect(validateUrl('http://169.254.10.1/internal').valid).toBe(false);
  });

  // ═══ IPv6 防护 ═══
  it('禁止 IPv6 loopback ::1', () => {
    expect(validateUrl('http://[::1]:3000').valid).toBe(false);
  });

  it('禁止 IPv6 link-local fe80::', () => {
    expect(validateUrl('http://[fe80::1]').valid).toBe(false);
  });

  it('禁止 IPv6 unique local fc00::', () => {
    expect(validateUrl('http://[fc00::1]').valid).toBe(false);
    expect(validateUrl('http://[fd00::1]').valid).toBe(false);
  });

  it('禁止 IPv4-mapped IPv6，避免私网 IPv4 标准化后绕过', () => {
    expect(validateUrl('http://[::ffff:10.0.0.1]').valid).toBe(false);
    expect(validateUrl('http://[::ffff:127.0.0.1]').valid).toBe(false);
    expect(validateUrl('http://[::ffff:192.168.1.1]').valid).toBe(false);
    expect(validateUrl('http://[::ffff:172.16.0.1]').valid).toBe(false);
    expect(validateUrl('http://[::ffff:169.254.10.1]').valid).toBe(false);
    expect(validateUrl('http://[::ffff:8.8.8.8]').valid).toBe(false);
  });

  // ═══ 非标准 IP 表达 ═══
  it('禁止十进制 IP', () => {
    expect(validateUrl('http://2130706433').valid).toBe(false); // 127.0.0.1
  });

  it('禁止十六进制 IP', () => {
    expect(validateUrl('http://0x7f000001').valid).toBe(false);
  });

  it('禁止八进制 IP', () => {
    expect(validateUrl('http://017700000001').valid).toBe(false);
  });
});

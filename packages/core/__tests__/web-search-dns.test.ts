import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as dns from 'node:dns/promises';
import { validateUrlWithDns } from '../src/tools/web-search.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

const mockLookup = vi.mocked(dns.lookup);

describe('validateUrlWithDns — DNS SSRF 防护', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  it('公网解析结果放行', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const result = await validateUrlWithDns('https://example.com/docs');

    expect(result.valid).toBe(true);
  });

  it('域名解析到 10.x 内网时拦截', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);

    const result = await validateUrlWithDns('https://safe-looking.example');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('DNS 解析目标被拦截');
  });

  it('域名解析到 169.254.0.0/16 元数据网段时拦截', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.10.1', family: 4 }]);

    const result = await validateUrlWithDns('https://metadata-proxy.example');

    expect(result.valid).toBe(false);
  });

  it('域名解析到 IPv6 link-local/unique-local 时拦截', async () => {
    mockLookup.mockResolvedValue([{ address: 'fe80::1', family: 6 }]);
    await expect(validateUrlWithDns('https://ipv6-local.example')).resolves.toMatchObject({ valid: false });

    mockLookup.mockResolvedValue([{ address: 'fd00::1', family: 6 }]);
    await expect(validateUrlWithDns('https://ipv6-ula.example')).resolves.toMatchObject({ valid: false });
  });

  it('DNS 临时失败时不误判为安全拦截，交给 fetch 返回具体错误', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));

    const result = await validateUrlWithDns('https://temporary-dns-fail.example');

    expect(result.valid).toBe(true);
  });
});

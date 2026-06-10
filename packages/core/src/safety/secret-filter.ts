// ============================================================
// Safety Layer — 密钥过滤器
// ============================================================

/**
 * 对发送给模型的内容进行密钥过滤
 */
export function filterSecrets(content: string): string {
  // 常见的密钥格式
  const patterns: Array<{ pattern: RegExp; replacement: string }> = [
    // OpenAI / DeepSeek API Key
    { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: 'sk-***REDACTED***' },
    // Anthropic API Key
    { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g, replacement: 'sk-ant-***REDACTED***' },
    // GitHub Token
    { pattern: /gh[pousr]_[a-zA-Z0-9]{20,}/g, replacement: 'gh*_***REDACTED***' },
    // 通用密钥赋值
    { pattern: /(SECRET|KEY|TOKEN|PASSWORD|PWD)\s*=\s*['"][^'"]{8,}['"]/gi, replacement: '$1=***REDACTED***' },
    // JWT Token
    { pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, replacement: 'JWT***REDACTED***' },
    // AWS Access Key
    { pattern: /AKIA[0-9A-Z]{16}/g, replacement: 'AKIA***REDACTED***' },
    // 私钥 (BEGIN 和 END 都替换)
    { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g, replacement: '***PRIVATE KEY BEGIN REDACTED***' },
    { pattern: /-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g, replacement: '***PRIVATE KEY END REDACTED***' },
  ];

  let filtered = content;
  for (const { pattern, replacement } of patterns) {
    filtered = filtered.replace(pattern, replacement);
  }

  return filtered;
}

/**
 * 判断文件内容是否包含疑似密钥
 */
export function containsSuspiciousSecrets(content: string): { hasSecrets: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (/sk-[a-zA-Z0-9]{20,}/.test(content)) {
    reasons.push('疑似 API Key (sk-...)');
  }
  if (/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/.test(content)) {
    reasons.push('疑似 JWT Token');
  }
  if (/-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/.test(content)) {
    reasons.push('疑似私钥文件');
  }
  if (/AKIA[0-9A-Z]{16}/.test(content)) {
    reasons.push('疑似 AWS Access Key');
  }
  if (/access_token\s*[:=]\s*['"][^'"]+/.test(content)) {
    reasons.push('疑似 access_token');
  }

  return { hasSecrets: reasons.length > 0, reasons };
}

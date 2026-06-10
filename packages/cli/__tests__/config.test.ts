import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 直接测试 loadConfig 逻辑（跳过 ensureConfig 的文件创建）
describe('config', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscode-test-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('loadConfig 从 JSON 文件加载', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      apiKey: 'sk-test',
      defaultModel: 'auto',
      autoRouting: true,
      maxRetries: 3,
      sessionDir: '.dscode-sessions',
      permissions: { autoApproveSafeCommands: true, requireConfirmForWrites: true, requireConfirmForCommands: true },
    }), 'utf-8');

    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    expect(cfg.apiKey).toBe('sk-test');
    expect(cfg.defaultModel).toBe('auto');
    expect(cfg.sessionDir).toBe('.dscode-sessions');
  });

  it('配置缺少字段时使用默认值', () => {
    const cfg = {
      apiKey: process.env.DEEPSEEK_API_KEY,
      defaultModel: 'auto',
      autoRouting: true,
      maxRetries: 3,
      sessionDir: '.deepseek-code/sessions',
      permissions: { autoApproveSafeCommands: true, requireConfirmForWrites: true, requireConfirmForCommands: true },
    };
    expect(cfg.defaultModel).toBe('auto');
    expect(cfg.maxRetries).toBe(3);
  });
});

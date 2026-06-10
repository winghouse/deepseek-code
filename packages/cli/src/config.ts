// ============================================================
// DeepSeek Code CLI — 配置管理
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { DeepSeekCodeConfig } from 'deepseek-code-shared';

export const CONFIG_DIR = path.join(homedir(), '.deepseek-code');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/**
 * 确保配置文件存在 —— 在任何命令执行前自动调用
 * 首次安装后静默创建，用户无需手动操作
 */
export function ensureConfig(): void {
  if (fs.existsSync(CONFIG_PATH)) return;

  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

  const configContent = `{
  "_说明": "DeepSeek Code CLI 配置文件。编辑此文件填入你的 API Key 即可使用。",
  "_模型选择": "defaultModel: auto=自动(简单任务Flash,复杂任务Pro) | deepseek-v4-pro=最强Agent | deepseek-v4-flash=快速经济",
  "_模型路由": "autoRouting: true 时，任务复杂度自动决定用 Pro 还是 Flash。设为 false 则固定使用 defaultModel。",
  "_搜索": "serperApiKey: 可选，填入 Serper API Key 启用 Google 质量搜索。不填则使用免费搜狗搜索。获取: https://serper.dev",

  "apiKey": "${apiKey}",
  "baseUrl": "${baseUrl}",
  "defaultModel": "auto",
  "autoRouting": true,
  "maxRetries": 3,
  "sessionDir": ".deepseek-code/sessions",
  "serperApiKey": "",
  "permissions": {
    "autoApproveSafeCommands": true,
    "requireConfirmForWrites": true,
    "requireConfirmForCommands": true
  }
}
`;

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, configContent, 'utf-8');

  console.log('🔧 已自动创建配置文件: ~/.deepseek-code/config.json');
  console.log('   请编辑此文件填入你的 DeepSeek API Key');
  console.log('   也可以设置环境变量 DEEPSEEK_API_KEY 跳过配置文件');
  console.log('');
}

export function loadConfig(): DeepSeekCodeConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      defaultModel: 'auto',
      autoRouting: true,
      maxRetries: 3,
      sessionDir: '.deepseek-code/sessions',
      serperApiKey: process.env.SERPER_API_KEY,
      permissions: {
        autoApproveSafeCommands: true,
        requireConfirmForWrites: true,
        requireConfirmForCommands: true,
      },
    };
  }
}

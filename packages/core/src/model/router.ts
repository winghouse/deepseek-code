// ============================================================
// Model Adapter — Pro / Flash 路由
// ============================================================

import type { ModelName } from 'deepseek-code-shared';
import { estimateTaskComplexity, recommendModel } from 'deepseek-code-shared';
import type { DeepSeekConfig } from './types.js';
import { DeepSeekClient } from './deepseek.js';

export interface ModelRouterConfig {
  strategy: 'auto' | 'pro' | 'flash';
  config: DeepSeekConfig;
  /** 当任务复杂度升级时，使用 Pro 的阈值 */
  upgradeThresholds?: {
    /** 修改文件数超过此值升级到 Pro */
    filesChanged: number;
    /** 测试失败次数超过此值升级到 Pro */
    testFailures: number;
    /** 工具调用步骤超过此值升级到 Pro */
    toolSteps: number;
  };
}

/**
 * 模型路由器
 *
 * 策略：
 * - auto: 先用 Flash 判断任务复杂度，简单任务 Flash，复杂任务 Pro
 * - pro: 始终使用 Pro
 * - flash: 始终使用 Flash
 */
export class ModelRouter {
  readonly strategy: ModelRouterConfig['strategy'];
  private config: DeepSeekConfig;
  private thresholds: Required<NonNullable<ModelRouterConfig['upgradeThresholds']>>;

  private proClient: DeepSeekClient;
  private flashClient: DeepSeekClient;

  constructor(routerConfig: ModelRouterConfig) {
    this.strategy = routerConfig.strategy;
    this.config = routerConfig.config;
    this.thresholds = {
      filesChanged: 5,
      testFailures: 1,
      toolSteps: 10,
      ...routerConfig.upgradeThresholds,
    };

    this.proClient = new DeepSeekClient('deepseek-v4-pro', this.config);
    this.flashClient = new DeepSeekClient('deepseek-v4-flash', this.config);
  }

  /**
   * 根据任务描述选择模型
   */
  selectModel(taskDescription: string): ModelName {
    if (this.strategy === 'pro') return 'deepseek-v4-pro';
    if (this.strategy === 'flash') return 'deepseek-v4-flash';

    // auto 模式
    const complexity = estimateTaskComplexity(taskDescription);
    return recommendModel(complexity);
  }

  /**
   * 获取客户端
   */
  getClient(modelName: ModelName): DeepSeekClient {
    return modelName === 'deepseek-v4-pro' ? this.proClient : this.flashClient;
  }

  /**
   * 任务过程中升级模型（如测试失败后的二次修复）
   */
  shouldUpgrade(metrics: { filesChanged?: number; testFailures?: number; toolSteps?: number }): boolean {
    if (this.strategy !== 'auto') return false;

    if ((metrics.filesChanged ?? 0) >= this.thresholds.filesChanged) return true;
    if ((metrics.testFailures ?? 0) >= this.thresholds.testFailures) return true;
    if ((metrics.toolSteps ?? 0) >= this.thresholds.toolSteps) return true;

    return false;
  }

  /** 获取 Pro 客户端 */
  get pro(): DeepSeekClient {
    return this.proClient;
  }

  /** 获取 Flash 客户端 */
  get flash(): DeepSeekClient {
    return this.flashClient;
  }
}

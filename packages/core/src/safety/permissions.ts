// ============================================================
// Safety Layer — 权限控制
// ============================================================

import type { CommandRiskLevel, PermissionDecision, PermissionRequest } from 'deepseek-code-shared';

/** 权限管理器配置 */
export interface PermissionConfig {
  /** 是否自动批准安全命令 */
  autoApproveSafeCommands: boolean;
  /** 写操作是否需要确认 */
  requireConfirmForWrites: boolean;
  /** 命令执行是否需要确认 */
  requireConfirmForCommands: boolean;
  /** 用户确认回调 */
  onConfirm?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** 始终允许的命令列表 */
  alwaysAllowCommands?: string[];
  /** 始终禁止的命令列表 */
  alwaysDenyCommands?: string[];
}

/** 权限管理器 */
export class PermissionManager {
  private config: PermissionConfig;
  private sessionDecisions = new Map<string, PermissionDecision>();

  constructor(config: PermissionConfig) {
    this.config = config;
  }

  /** 检查命令风险等级 */
  assessCommandRisk(command: string): CommandRiskLevel {
    // 禁止命令
    const forbiddenPatterns = [
      /rm\s+-rf\s+\//,
      /rmdir\s+\/[sq]/i,
      /del\s+\/[sfq]\s+[A-Z]:\\/i,
      /format\s+[a-z]:/i,
      /diskpart/i,
      /reg\s+delete/i,
      /curl\s+.*\|\s*(ba)?sh/,
      /curl\s+.*\|\s*python/,
      /wget\s+.*\s*-\s*O\s*-\s*\|/,
      /eval\s+/,
      />\s*\/dev\/sda/,
      /mkfs\./,
      /dd\s+if=/,
      /chmod\s+777\s+\/\s*$/,
      /chmod\s+777\s+\/(etc|proc|sys|boot)\b/,
      />\s*\/etc\//,
      /Remove-Item\s+-Recurse\s+-Force/i,
    ];
    if (forbiddenPatterns.some((p) => p.test(command))) return 'forbidden';

    const dangerousPatterns = [
      /rm\s+-rf/,
      /rm\s+-r/,
      /rmdir\s+\/[sq]/i,
      /del\s+\/[sfq]/i,
      /git\s+reset\s+--hard/,
      /git\s+push\s+--force/,
      /npm\s+unpublish/,
      /docker\s+rm/,
      /docker\s+system\s+prune/,
      /sudo\s+/,
      /chmod\s+777/,
      /chown\s+-R/,
    ];
    if (dangerousPatterns.some((p) => p.test(command))) return 'dangerous';

    // 需要确认的命令
    const needsConfirmPatterns = [
      /npm\s+install/,
      /pnpm\s+add/,
      /yarn\s+add/,
      /npm\s+remove/,
      /pnpm\s+remove/,
      /yarn\s+remove/,
      /git\s+checkout/,
      /git\s+commit/,
      /git\s+rebase/,
      /git\s+merge/,
      /git\s+push/,
      /git\s+pull/,
      /npm\s+run\s+migrate/,
      /prisma\s+migrate/,
      /docker\s+(build|compose|run)/,
      /npm\s+(link|unlink)/,
    ];
    if (needsConfirmPatterns.some((p) => p.test(command))) return 'needs_confirm';

    // 安全命令
    return 'safe';
  }

  /** 请求权限 */
  async requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    const key = `${request.type}:${request.target}`;

    // 检查已记录的决策
    const cached = this.sessionDecisions.get(key);
    if (cached === 'allow_always' || cached === 'deny') {
      return cached;
    }

    // 自动决策
    if (request.risk === 'forbidden') return 'deny';
    if (request.risk === 'safe' && this.config.autoApproveSafeCommands) return 'allow_once';

    // 自定义规则
    if (this.config.alwaysAllowCommands?.some((c) => request.target.includes(c))) return 'allow_once';
    if (this.config.alwaysDenyCommands?.some((c) => request.target.includes(c))) return 'deny';

    // 需要用户确认
    if (this.config.onConfirm) {
      const decision = await this.config.onConfirm(request);
      if (decision === 'allow_always' || decision === 'deny') {
        this.sessionDecisions.set(key, decision);
      }
      return decision;
    }

    // 默认：需要确认的操作拒绝
    return request.risk === 'safe' ? 'allow_once' : 'deny';
  }

  /** 重置会话决策 */
  resetSession(): void {
    this.sessionDecisions.clear();
  }
}

/** 创建默认权限配置 */
export function createDefaultPermissionConfig(
  onConfirm?: (request: PermissionRequest) => Promise<PermissionDecision>,
): PermissionConfig {
  return {
    autoApproveSafeCommands: true,
    requireConfirmForWrites: true,
    requireConfirmForCommands: true,
    onConfirm,
    alwaysAllowCommands: [
      'npm test',
      'npm run build',
      'npm run lint',
      'pnpm lint',
      'pnpm build',
      'pnpm test',
      'git diff',
      'git status',
      'git log',
      'rg ',
      'ls ',
    ],
    alwaysDenyCommands: [
      'rm -rf /',
      'del /s /q',
      'format',
      'curl | bash',
      '> /etc/',
    ],
  };
}

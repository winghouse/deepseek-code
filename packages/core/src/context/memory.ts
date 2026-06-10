// ============================================================
// Context Engine — 会话记忆管理
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session, AgentStep, ExternalResource } from 'deepseek-code-shared';

export interface MemoryStore {
  /** 保存会话 */
  saveSession(session: Session): Promise<void>;
  /** 加载会话 */
  loadSession(sessionId: string): Promise<Session | null>;
  /** 列出所有会话 */
  listSessions(): Promise<{ id: string; createdAt: Date; taskDescription: string; completed: boolean }[]>;
  /** 删除会话 */
  deleteSession(sessionId: string): Promise<void>;
}

/**
 * 基于文件的会话存储
 */
export class FileMemoryStore implements MemoryStore {
  private sessionsDir: string;

  constructor(baseDir: string) {
    this.sessionsDir = path.join(baseDir, '.deepseek-code', 'sessions');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  async saveSession(session: Session): Promise<void> {
    const filePath = path.join(this.sessionsDir, `${session.id}.json`);
    const tmpPath = filePath + '.tmp';
    const data = JSON.stringify(session, null, 2);
    // 原子写入：先写临时文件，再 rename（防并发覆盖）
    fs.writeFileSync(tmpPath, data, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  async listSessions(): Promise<{ id: string; createdAt: Date; taskDescription: string; completed: boolean }[]> {
    try {
      const files = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json'));
      return files
        .map((f) => {
          try {
            const s = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), 'utf-8')) as Session;
            return { id: s.id, createdAt: s.createdAt, taskDescription: s.taskDescription, completed: s.completed };
          } catch {
            return null;
          }
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch {
      return [];
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

/**
 * 内存存储（用于测试）
 */
export class InMemoryStore implements MemoryStore {
  private sessions = new Map<string, Session>();

  async saveSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listSessions(): Promise<{ id: string; createdAt: Date; taskDescription: string; completed: boolean }[]> {
    return Array.from(this.sessions.values())
      .map((s) => ({ id: s.id, createdAt: s.createdAt, taskDescription: s.taskDescription, completed: s.completed }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

/** 创建 AgentStep */
export function createStep(
  index: number,
  type: AgentStep['type'],
  content: string,
): AgentStep {
  return { index, type, content, timestamp: new Date() };
}

// ═══ 交互会话状态持久化 ═══

/**
 * 待处理动作，用于 "继续" 命令恢复上下文
 */
export interface PendingAction {
  type: 'apply_patch' | 'run_verification' | 'resume_repair' | 'awaiting_confirmation';
  description: string;
  taskId?: string;
  /** 上下文数据 */
  context: Record<string, unknown>;
  createdAt: string;
}

/**
 * 交互会话状态，持久化到 .deepseek-code/sessions/interactive-current.json
 */
export interface InteractiveSessionState {
  projectPath: string;
  lastAgentResult?: {
    task: string;
    intent: string;
    execution: string;
    summary: string;
    filesRead: string[];
    toolsUsed: string[];
    findings: string[];
    nextSuggestions: string[];
    completedAt: string;
  };
  pendingAction?: PendingAction;
  /** 上一轮涉及的外部资源（URL/网页），用于上下文追问继承 */
  lastExternalResource?: ExternalResource;
  /** 最近访问的外部资源历史 */
  recentExternalResources: ExternalResource[];
  chatHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  /** 长对话压缩摘要 (V4 智能摘要) */
  chatSummaries?: string[];
  updatedAt: string;
}

const INTERACTIVE_STATE_FILE = 'interactive-current.json';

/** 保存交互会话状态 */
export function saveInteractiveState(baseDir: string, state: InteractiveSessionState): void {
  const dir = path.join(baseDir, '.deepseek-code', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, INTERACTIVE_STATE_FILE);
  const tmpPath = filePath + '.tmp';
  const data = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
  fs.writeFileSync(tmpPath, data, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/** 加载交互会话状态 */
export function loadInteractiveState(baseDir: string): InteractiveSessionState | null {
  const filePath = path.join(baseDir, '.deepseek-code', 'sessions', INTERACTIVE_STATE_FILE);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const state = JSON.parse(raw) as InteractiveSessionState;
    // 向后兼容：旧状态文件可能没有这些字段
    if (!state.recentExternalResources) state.recentExternalResources = [];
    return state;
  } catch {
    return null;
  }
}

/** 删除交互会话状态（/new 命令时调用） */
export function clearInteractiveState(baseDir: string): void {
  const filePath = path.join(baseDir, '.deepseek-code', 'sessions', INTERACTIVE_STATE_FILE);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/** 从 Agent 结果构建 lastAgentResult */
export function buildLastAgentResult(
  task: string,
  session: { summary?: string; steps: Array<{ type: string; content: string; toolResults?: Array<{ content: string }> }> },
): InteractiveSessionState['lastAgentResult'] {
  const toolSteps = session.steps.filter((s) => s.type === 'tool_call');
  const filesRead = new Set<string>();
  const toolsUsed = new Set<string>();
  const findings: string[] = [];

  for (const step of toolSteps) {
    toolsUsed.add(step.content.slice(0, 30));
    for (const r of step.toolResults ?? []) {
      const fileMatch = r.content.match(/File:\s*(.+)/);
      if (fileMatch) filesRead.add(fileMatch[1]);
      if (step.content.includes('search_code') || step.content.includes('find_references')) {
        findings.push(step.content.slice(0, 100));
      }
    }
  }

  return {
    task: task.slice(0, 200),
    intent: 'debug_task',
    execution: 'agent_readonly',
    summary: session.summary?.slice(0, 300) ?? '',
    filesRead: [...filesRead].slice(0, 20),
    toolsUsed: [...toolsUsed].slice(0, 10),
    findings: findings.slice(0, 5),
    nextSuggestions: [],
    completedAt: new Date().toISOString(),
  };
}

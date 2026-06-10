// ============================================================
// Workflow Runner v0 — 编排 dscode 已有 pipeline / tool
// 不做通用 Workflow Engine，服务 review-diff / repair / code-review
// ============================================================

// ---- 节点定义 ----

/** 工作流节点类型（v0：5 种，LLM 后置） */
export type WorkflowNodeType =
  | 'BEGIN'
  | 'END'
  | 'TOOL'
  | 'PIPELINE'
  | 'CONDITION';

/** 工作流节点 */
export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /** 人类可读名称 */
  name?: string;
  /** TOOL: 工具名 / PIPELINE: 管线名 / CONDITION: 表达式 */
  tool?: string;
  pipeline?: string;
  expression?: string;
  /** 节点参数，支持 ${...} 模板变量 */
  params?: Record<string, unknown>;
  /** 超时 ms（覆盖 workflow 级 timeout） */
  timeoutMs?: number;
}

/** 工作流边 */
export interface WorkflowEdge {
  /** 源节点 ID */
  from: string;
  /** 目标节点 ID */
  to: string;
  /** CONDITION 分支条件（true/false），不填默认无条件 */
  condition?: string;
}

// ---- 工作流定义 ----

/** 工作流输入参数定义 */
export interface WorkflowInputSpec {
  type: 'string' | 'number' | 'boolean' | 'json';
  default?: unknown;
  description?: string;
  required?: boolean;
}

/** 工作流预算 */
export interface WorkflowBudget {
  /** 最大节点执行数 */
  maxNodes: number;
  /** 最大工具调用数 */
  maxToolCalls: number;
  /** 超时 ms */
  timeoutMs: number;
}

/** 工作流定义（JSON 文件格式） */
export interface WorkflowDefinition {
  schemaVersion: '0.1';
  id: string;
  name: string;
  description?: string;
  inputs?: Record<string, WorkflowInputSpec>;
  budgets?: Partial<WorkflowBudget>;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

// ---- 运行时 ----

/** 节点执行状态 */
export type NodeStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'blocked';

/** 统一节点执行结果 */
export interface WorkflowNodeResult {
  nodeId: string;
  type: WorkflowNodeType;
  status: NodeStatus;
  startedAt: string;
  endedAt: string;
  output?: unknown;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  /** 工具调用次数（仅 TOOL/PIPELINE） */
  toolCalls?: number;
  /** 生成物（如文件路径） */
  artifacts?: string[];
}

/** 工作流运行状态 */
export type RunStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';

/** 工作流运行记录 */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: RunStatus;
  input: Record<string, unknown>;
  nodeResults: Record<string, WorkflowNodeResult>;
  currentNodeIds: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  totalToolCalls: number;
  stopReason?: string;
  errors: string[];
}

// ---- 工作流上下文（权限边界） ----

/** 工作流执行上下文——每条 TOOL/PIPELINE 都带这个，不能绕开权限 */
export interface WorkflowExecutionContext {
  mode: 'readonly' | 'ask' | 'auto';
  workspaceRoot: string;
  sessionId: string;
  allowedTools: string[];
  budgets: WorkflowBudget;
  traceId: string;
}

// ---- 默认预算 ----

export const DEFAULT_WORKFLOW_BUDGET: WorkflowBudget = {
  maxNodes: 20,
  maxToolCalls: 20,
  timeoutMs: 120_000,
};

/** 模板变量替换最大字符数（防 token 爆炸） */
export const MAX_TEMPLATE_VALUE_LENGTH = 8000;

// ============================================================
// DeepSeek Code — 共享类型定义
// ============================================================

// ---- 模型相关 ----

/** 支持的模型 */
export type ModelName = typeof MODEL_PRO | typeof MODEL_FLASH | 'auto';

/** 模型名常量——避免硬编码，升级 V5 时只改这里 */
export const MODEL_PRO = 'deepseek-v4-pro' as const;
export const MODEL_FLASH = 'deepseek-v4-flash' as const;

/** 模型路由策略 */
export type ModelRoutingStrategy = 'auto' | 'pro' | 'flash';

/** 模型调用消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** 工具调用请求（模型输出） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 工具调用结果（返回给模型） */
export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  content: string;
}

/** 模型响应（非流式） */
export interface ModelResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  usage: TokenUsage;
}

/** Token 用量 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hit_tokens?: number;
}

// ---- 工具定义 ----

/** 工具 JSON Schema 定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 工具执行结果 */
export interface ToolExecutionResult {
  success: boolean;
  content: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

// ---- Agent 相关 ----

/** 任务复杂度等级 */
export type TaskComplexity = 'simple' | 'medium' | 'complex';

/** Agent 执行阶段 */
export type AgentPhase =
  | 'initializing'
  | 'scanning'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'analyzing'
  | 'awaiting_patch_approval'
  | 'applying_patch'
  | 'verifying'
  | 'repairing'
  | 'completed'
  | 'failed';

/** Agent 运行模式 */
export type AgentMode = 'readonly' | 'ask' | 'auto';

/** Phase 转换表 — 显式状态机，防非法迁移 */
export const VALID_PHASE_TRANSITIONS: Record<AgentPhase, AgentPhase[]> = {
  initializing: ['scanning', 'planning', 'failed'],
  scanning: ['planning', 'analyzing', 'failed'],
  planning: ['awaiting_plan_approval', 'analyzing', 'scanning', 'failed'],
  awaiting_plan_approval: ['analyzing', 'scanning', 'failed'],
  analyzing: ['awaiting_patch_approval', 'applying_patch', 'verifying', 'repairing', 'completed', 'failed'],
  awaiting_patch_approval: ['applying_patch', 'repairing', 'analyzing', 'failed'],
  applying_patch: ['verifying', 'repairing', 'failed'],
  verifying: ['completed', 'repairing', 'analyzing', 'failed'],
  repairing: ['verifying', 'analyzing', 'failed'],
  completed: [],
  failed: ['initializing'],
};

/** 尝试迁移到新 phase，非法迁移返回 false */
export function canTransitionPhase(from: AgentPhase, to: AgentPhase): boolean {
  const allowed = VALID_PHASE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/** 工具调用缓存条目 */
export interface ToolCacheEntry {
  cacheKey: string;
  result: ToolExecutionResult;
  fileHash?: string;
  timestamp: Date;
}

/** Agent 步骤 */
export interface AgentStep {
  index: number;
  type: 'tool_call' | 'planning' | 'thinking' | 'final';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolExecutionResult[];
  timestamp: Date;
  /** 是否命中缓存 */
  fromCache?: boolean;
}

/** Agent 会话 */
export interface Session {
  id: string;
  createdAt: Date;
  taskDescription: string;
  modelName: ModelName;
  workingDir: string;
  steps: AgentStep[];
  repoInfo?: RepoInfo;
  completed: boolean;
  summary?: string;

  // ---- 新增：状态机字段 ----
  phase: AgentPhase;
  mode: AgentMode;
  lastCompletedStepId?: number;
  lastPendingAction?: string;
  interruptionReason?: string;
  plan?: ExecutionPlan;
  patchProposal?: string;
  appliedPatches: string[];
  commandHistory: string[];
  knownFiles: string[];
  toolResultsCache: Record<string, ToolCacheEntry>;
  staleFiles?: string[];
  stopReason?: StopReason;
}

/** 执行计划 */
export interface ExecutionPlan {
  taskDescription: string;
  complexity: TaskComplexity;
  recommendedModel: ModelName;
  steps: PlanStep[];
  estimatedFiles: string[];
  risks: string[];
}

/** 计划步骤 */
export interface PlanStep {
  order: number;
  action: 'read' | 'search' | 'analyze' | 'modify' | 'run_command' | 'verify';
  description: string;
  targetFiles?: string[];
  command?: string;
  reason: string;
}

// ---- 项目扫描 ----

/** 项目信息 */
export interface RepoInfo {
  name: string;
  rootDir: string;
  techStack: TechStack;
  structure: ProjectStructure;
  rules: ProjectRules;
  git?: GitInfo;
}

/** 技术栈识别 */
export interface TechStack {
  language: string;
  framework: string | null;
  buildTool: string;
  packageManager: string;
  runtime: string;
  uiLibrary: string | null;
  orm: string | null;
  testFramework: string | null;
}

/** 项目结构 */
export interface ProjectStructure {
  hasSrcDir: boolean;
  entryFiles: string[];
  routeFiles: string[];
  configFiles: string[];
  keyDirectories: string[];
}

/** 项目规则 */
export interface ProjectRules {
  agentsMd: string | null;
  readme: string | null;
  packageJson: Record<string, unknown> | null;
  eslintConfig: Record<string, unknown> | null;
  tsconfig: Record<string, unknown> | null;
}

/** Git 信息 */
export interface GitInfo {
  branch: string;
  status: string;
  hasUncommittedChanges: boolean;
  lastCommit?: string;
}

// ---- 安全与权限 ----

/** 命令风险等级 */
export type CommandRiskLevel = 'safe' | 'needs_confirm' | 'dangerous' | 'forbidden';

/** 权限决策 */
export type PermissionDecision = 'allow' | 'deny' | 'allow_once' | 'allow_always';

/** 权限请求 */
export interface PermissionRequest {
  type: 'read_file' | 'write_file' | 'run_command' | 'apply_patch' | 'delete_file';
  target: string;
  risk: CommandRiskLevel;
  reason: string;
}

// ---- 意图分类 ----

export type UserIntent =
  | 'command_help'
  | 'command_exit'
  | 'command_clear'
  | 'command_status'
  | 'command_model'
  | 'command_sessions'
  | 'command_resume'
  | 'small_talk'
  | 'capability_question'
  | 'explain_project'
  | 'debug_task'
  | 'code_task'
  | 'test_task'
  | 'config_task'
  | 'conversation_summary'
  | 'previous_result_question'
  | 'continue_previous_task'
  | 'audit_task'
  // 外部资源类意图 (URL/网页/文档)
  | 'webpage_summary'          // "这个链接是做什么的？"
  | 'webpage_content_question' // "网页内容是什么？"
  | 'external_doc_question'    // "这个文档怎么接入？"
  | 'url_safety_check'         // "这个链接安全吗？"
  | 'unknown';

// ═══ RouteTarget — 先识别目标对象，再识别意图 ═══

/** 用户的目标对象类型 */
export type RouteTarget =
  | { type: 'workspace' }
  | {
      type: 'url';
      url: string;
      /** explicit=用户直接提供了URL, last_external_resource=从上一轮继承 */
      source: 'explicit' | 'last_external_resource';
    }
  | { type: 'chat_history' }
  | { type: 'git_diff' }
  | { type: 'file'; path: string }
  | { type: 'unknown' };

export type ExecutionMode =
  | 'local_action'      // 本地确定性命令，不调模型不扫项目不进Agent
  | 'llm_direct'        // 调模型但不进 Agent Loop
  | 'llm_direct_limited' // 调模型但明确告知能力边界（如不能读网页）
  | 'agent_readonly'    // 只读 Agent
  | 'agent_plan'        // Agent 生成计划后可执行
  | 'agent_execute'     // 允许修改/执行
  | 'url_fetch_pipeline'; // 受控网页抓取管线（不进入通用 Agent）

export interface RouteDecision {
  intent: UserIntent;
  execution: ExecutionMode;
  /** 用户的目标对象（先于 intent 确定） */
  target?: RouteTarget;
  shouldScanProject: boolean;
  allowedTools: string[];
  needsClarification?: boolean;
  reason?: string;
  confidence: number;            // 0-1
  analysisDepth?: 'none' | 'overview' | 'standard' | 'deep';
}

// ═══ External Resource Memory ═══
// ExternalResource 定义见下方 (Web Fetch 段)

// ---- CLI 配置 ----

/** 用户配置 */
export interface DeepSeekCodeConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel: ModelName;
  autoRouting: boolean;
  maxRetries: number;
  sessionDir: string;
  /** Serper API Key (Google 搜索，可选) */
  serperApiKey?: string;
  permissions: {
    autoApproveSafeCommands: boolean;
    requireConfirmForWrites: boolean;
    requireConfirmForCommands: boolean;
  };
}

// ---- Agent State ----

export type StopReason =
  | 'done'
  | 'needs_user_input'
  | 'tool_blocked'
  | 'too_many_failures'
  | 'no_progress'
  | 'budget_exceeded';

// ---- Router Eval ----

export interface RouteTrace {
  commandRouterHit: boolean;
  heuristicRouterHit: boolean;
  llmRouterCalled: boolean;
  llmRouterRawOutput?: string;
  llmRouterParseOk?: boolean;
  llmRouterFallbackReason?: string;
  beforeGuardDecision?: RouteDecision;
  afterGuardDecision?: RouteDecision;
}

export interface RouterEvalCase {
  id: string;
  suite: string;
  input: string;
  mode: 'readonly' | 'ask' | 'auto';
  context?: {
    project?: { name: string; path: string };
    chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    lastAgentResult?: unknown;
    pendingAction?: unknown;
  };
  expected: Partial<RouteDecision>;
  acceptedAlternatives?: Array<Partial<RouteDecision>>;
  assertions?: {
    allowedToolsMustContain?: string[];
    allowedToolsMustNotContain?: string[];
    mustNotCallLLMRouter?: boolean;
    mustCallLLMRouter?: boolean;
    mustNotScanProject?: boolean;
    mustNotEnterAgent?: boolean;
  };
  risk: 'P0' | 'P1' | 'P2';
}

// ---- Verified Audit ----

export type AuditCategory =
  | 'config' | 'test' | 'type-safety' | 'dead-code' | 'docs'
  | 'security' | 'cross-platform' | 'architecture' | 'maintainability';

/** 发现类型 */
export type FindingKind =
  | 'verified_issue'
  | 'partial_issue'
  | 'suggestion'
  | 'needs_manual_review'
  | 'rejected';

/** 证据强度 */
export type EvidenceStrength = 'strong' | 'medium' | 'weak';

/** 审计模式 */
export type AuditMode = 'quick' | 'standard' | 'deep';

/** 审计范围 */
export type AuditScope =
  | 'config' | 'test' | 'type-safety' | 'dead-code' | 'docs'
  | 'security' | 'cross-platform' | 'architecture' | 'maintainability'
  | 'error-handling' | 'performance' | 'dependency';

export interface AuditFinding {
  id: string;
  title: string;
  category: AuditCategory;
  severity: 'low' | 'medium' | 'high';
  claim: string;
  evidence: AuditEvidence[];
  verificationStatus: 'unverified' | 'verified' | 'rejected' | 'partial';
  /** 发现类型 */
  findingKind?: FindingKind;
  /** 证据强度 */
  evidenceStrength?: EvidenceStrength;
  confidence: number;
  suggestedFix?: string;
  rejectionReason?: string;
}

export interface AuditEvidence {
  file: string;
  lineStart?: number;
  lineEnd?: number;
  jsonPath?: string;
  symbol?: string;
  snippet?: string;
  tool: 'read_file' | 'read_json_path' | 'search_code' | 'find_references' | 'list_files' | 'run_static_check' | 'list_scripts' | 'file_exists';
}

export interface AuditReport {
  totalCandidates: number;
  verified: number;
  partial: number;
  rejected: number;
  needsManualReview?: number;
  findings: AuditFinding[];
  rejectedFindings?: AuditFinding[];
  elapsedMs: number;
  tokensEstimate: number;
  scopes?: AuditScope[];
  mode?: AuditMode;
}

// ---- MCP 预留 ----

/** MCP 工具注册项 */
export interface MCPToolRegistration {
  name: string;
  description: string;
  serverName: string;
  parameters: Record<string, unknown>;
}

// ---- Web Search (based on Codex web_search tool design) ----

/** 搜索上下文大小（对应 Codex WebSearchContextSize） */
export type WebSearchContextSize = 'low' | 'medium' | 'high';

/** Web Search 工具配置（对应 Codex WebSearchToolConfig） */
export interface WebSearchConfig {
  /** 搜索结果上下文量: low=仅标题, medium=标题+摘要, high=标题+摘要+全文 */
  contextSize?: WebSearchContextSize;
  /** 限定搜索域名（如 "github.com"），使用 site: 语法精确到单个站 */
  site?: string;
  /** 允许的域名白名单 */
  allowedDomains?: string[];
  /** 最大结果数 */
  maxResults?: number;
  /** 搜索超时 (ms) */
  timeout?: number;
}

/** 单条搜索结果 */
export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  /** 全文内容（仅在 contextSize=high 时获取） */
  content?: string;
  /** 相关度评分 0-1 */
  relevance?: number;
}

/** Web Search 工具返回结果 */
export interface WebSearchResult {
  success: boolean;
  query: string;
  results: WebSearchResultItem[];
  totalEstimated: number;
  elapsedMs: number;
  /** 搜索来源 */
  source: 'duckduckgo' | 'tavily' | 'custom' | 'sogou' | 'serper';
  error?: string;
}

/** Web Fetch 工具配置 */
export interface WebFetchConfig {
  /** 最大返回字符数（单页），默认 5000 */
  maxChars?: number;
  /** 超时 (ms)，默认 15000 */
  timeout?: number;
  /** 返回格式: text=纯文本, markdown=保留基本结构 */
  format?: 'text' | 'markdown';
  /** 最大遍历页数（自动检测"下一页"链接），默认 1（不遍历）。设为 0 表示不限制 */
  maxPages?: number;
}

/** 网页抓取质量 */
export type FetchQuality = 'complete' | 'partial' | 'empty' | 'blocked' | 'unsupported_content_type';

/** Web Fetch 工具返回结果 */
export interface WebFetchResult {
  success: boolean;
  url: string;
  finalUrl?: string;
  title?: string;
  content: string;
  contentLength: number;
  elapsedMs: number;
  /** 内容质量标记 */
  fetchQuality?: FetchQuality;
  error?: string;
}

/** 外部资源记录 (带缓存) */
export interface ExternalResource {
  url: string;
  finalUrl?: string;
  title?: string;
  summary?: string;
  textHash?: string;
  fetchedAt?: string;
  /** 缓存有效期 (ISO date)，默认 10min */
  expiresAt?: string;
  /** 内容质量标记 */
  fetchQuality?: FetchQuality;
}

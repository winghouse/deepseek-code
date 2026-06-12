// ============================================================
// Hybrid Router: Command → Heuristic → LLM → Permission Guard
// ============================================================

import type { RouteDecision, RouteTarget, UserIntent, ExecutionMode, ExternalResource } from 'deepseek-code-shared';
import { READ_ONLY_TOOLS as READ_ONLY_DEFS, WRITE_TOOLS as WRITE_DEFS } from '../tools/definitions.js';

export interface LastAgentResult {
  task: string;
  intent: UserIntent;
  execution: ExecutionMode;
  summary: string;
  filesRead: string[];
  toolsUsed: string[];
  findings: string[];
  nextSuggestions: string[];
  completedAt: string;
}

/** 对话焦点——追踪上一轮回答中提到的核心对象，用于短追问路由 */
export interface ConversationFocus {
  kind: 'file' | 'symbol' | 'component' | 'url' | 'git_diff' | 'agent_result';
  label: string;
  file?: string;
  symbol?: string;
  confidence: number;
}

export interface RouterContext {
  mode: 'readonly' | 'ask' | 'auto';
  projectName?: string;
  projectPath?: string;
  lastAgentResult?: LastAgentResult;
  recentMessages?: Array<{ role: string; content: string }>;
  pendingAction?: string;
  isGitRepo?: boolean;
  /** 上一轮涉及的外部资源 */
  lastExternalResource?: ExternalResource;
  /** 上一轮回答聚焦的对象 */
  conversationFocus?: ConversationFocus;
}

// ═══════════════════════════════════════
// Target Resolver — 先判断目标对象，再判断意图
// ═══════════════════════════════════════

/**
 * 从用户输入中提取目标对象
 *
 * 优先级:
 * 1. 显式 URL → target=url(explicit)
 * 2. 引用上轮 URL ("这个网页"/"上面的链接") + lastExternalResource → target=url(last_external_resource)
 * 3. Git diff 关键词 + isGitRepo → target=git_diff
 * 4. 聊天回顾关键词 → target=chat_history
 * 5. 默认 → target=workspace (由后续 intent router 覆盖)
 */
function resolveTarget(input: string, ctx: RouterContext): RouteTarget {
  const text = input.trim();

  // 1. 显式 URL
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (urlMatch) {
    return { type: 'url', url: urlMatch[0], source: 'explicit' };
  }

  // 2. 引用上轮 URL
  if (ctx.lastExternalResource?.url) {
    const urlRefPatterns = /这个网页|网页内容|这个链接|上面的链接|刚才.*网页|刚才.*链接|这个页面|这个文档|里面.*内容|里面.*写/i;
    if (urlRefPatterns.test(text)) {
      return {
        type: 'url',
        url: ctx.lastExternalResource.url,
        source: 'last_external_resource',
      };
    }
  }

  // 3. Git diff
  if (ctx.isGitRepo && /\bdiff\b|改动|变更|修改了.*文件/i.test(text) && !/\bweb|网页|url|http/i.test(text)) {
    return { type: 'git_diff' };
  }

  // 4. Chat history（排除 URL 引用场景）
  if (/上面.*聊|刚才.*说|总结.*对话|回顾|我们.*聊|聊天记录/i.test(text) &&
      !/这个网页|网页内容|这个链接|上面的链接|这个页面|这个文档/i.test(text)) {
    return { type: 'chat_history' };
  }

  // 5. Default: workspace
  return { type: 'workspace' };
}

/**
 * 根据 target 调整 RouteDecision
 *
 * 硬性规则：
 * - target=url 且无 fetch 能力时 → llm_direct_limited（禁止编造网页内容）
 * - target=url 时 → shouldScanProject=false
 * - target=chat_history 时 → shouldScanProject=false
 * - target=url 时 → 不允许 explain_project
 */
function applyTargetGuard(decision: RouteDecision, target: RouteTarget): RouteDecision {
  const d = { ...decision, target };

  switch (target.type) {
    case 'url':
      d.shouldScanProject = false;
      // url 类任务不能走 explain_project / debug_task / code_task
      if (['explain_project', 'debug_task', 'code_task', 'test_task', 'config_task'].includes(d.intent)) {
        if (d.execution === 'agent_readonly' || d.execution === 'agent_plan' || d.execution === 'agent_execute') {
          // 有 web_fetch 工具时走 url_fetch_pipeline
          // 否则降级为 llm_direct_limited
          d.intent = 'webpage_summary';
          d.execution = 'url_fetch_pipeline';
          d.reason = `URL target 修正: ${d.reason ?? '原路由'} → url_fetch_pipeline`;
        }
      }
      break;

    case 'chat_history':
    case 'git_diff':
      d.shouldScanProject = false;
      break;

    case 'workspace':
      // workspace 保持不变，由 intent router 决定
      break;
  }

  return d;
}

// ═══════════════════════════════════════
// Command Router — CLI 命令直接本地处理
// ═══════════════════════════════════════

function commandRouter(input: string): RouteDecision | null {
  const text = input.trim().toLowerCase();
  const cmds: Record<string, { intent: UserIntent; reason: string }> = {
    'help': { intent: 'command_help', reason: 'CLI命令' },
    '?': { intent: 'command_help', reason: 'CLI命令' }, '？': { intent: 'command_help', reason: 'CLI命令' },
    '帮助': { intent: 'command_help', reason: 'CLI命令' }, '/help': { intent: 'command_help', reason: 'CLI命令' },
    '/status': { intent: 'command_status', reason: 'CLI命令' }, 'status': { intent: 'command_status', reason: 'CLI命令' },
    '/sessions': { intent: 'command_sessions', reason: 'CLI命令' }, 'sessions': { intent: 'command_sessions', reason: 'CLI命令' },
    '/model': { intent: 'command_model', reason: 'CLI命令' }, 'model': { intent: 'command_model', reason: 'CLI命令' },
    '/exit': { intent: 'command_exit', reason: 'CLI命令' }, 'exit': { intent: 'command_exit', reason: 'CLI命令' }, '退出': { intent: 'command_exit', reason: 'CLI命令' },
    '/clear': { intent: 'command_clear', reason: 'CLI命令' }, 'clear': { intent: 'command_clear', reason: 'CLI命令' }, '清屏': { intent: 'command_clear', reason: 'CLI命令' },
    '/diff': { intent: 'command_status', reason: 'CLI命令' },
    '--resume': { intent: 'command_resume', reason: 'CLI命令' }, '/resume': { intent: 'command_resume', reason: 'CLI命令' },
  };
  // --resume <id> 或 /resume <id> 前缀匹配
  if (/^--resume\b|\/resume\b/.test(text)) {
    return { intent: 'command_resume', execution: 'local_action', shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 1, reason: 'CLI命令: resume' };
  }
  const cmd = cmds[text];
  if (!cmd) return null;
  return { intent: cmd.intent, execution: 'local_action', shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 1, reason: cmd.reason };
}


// ═══════════════════════════════════════
// Heuristic Router — 最小安全网，意图分类交给 LLM Router
// ═══════════════════════════════════════

function heuristicRouter(text: string, ctx: RouterContext): RouteDecision | null {
  // 短追问 → 读取 focus 文件
  if (ctx.conversationFocus?.file && /^(讲一下|详细|展开|说说|再讲|解释|怎么)/.test(text) && text.length <= 8) {
    return { intent: "code_task", execution: "agent_readonly", target: { type: "file", path: ctx.conversationFocus.file }, shouldScanProject: false, allowedTools: ["read_file", "read_file_range"], needsClarification: false, confidence: 0.85, reason: "短追问 → focus" };
  }
  // 纯寒暄
  if (/^(你好|hi|hello|hey|哈喽|在吗)s*$/i.test(text)) {
    return { intent: "small_talk", execution: "llm_direct", shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.95, reason: "寒暄" };
  }
  // Target 路由
  const target = resolveTarget(text, ctx);
  if (target.type === "url") {
    return { intent: "webpage_summary", execution: "url_fetch_pipeline", shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.9, reason: "URL" };
  }
  if (target.type === "git_diff") {
    return { intent: "command_status", execution: "llm_direct", shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.9, reason: "diff" };
  }
  if (target.type === "chat_history" && ctx.lastAgentResult && /继续|然后再|接着/i.test(text)) {
    return { intent: "continue_previous_task", execution: ctx.mode === "readonly" ? "agent_readonly" : "agent_plan", shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.85, reason: "继续" };
  }
  return null;
}

// ═══════════════════════════════════════
// LLM Router — 轻量意图分类
// ═══════════════════════════════════════

export interface LLMRouterClient {
  chatJson(prompt: string): Promise<string>;
}

export async function llmRouter(
  input: string,
  ctx: RouterContext,
  client?: LLMRouterClient,
  target?: RouteTarget,
): Promise<RouteDecision> {
  // 无 client 时降级为 heuristic 或 clarification
  if (!client) {
    return fallbackClarification(input);
  }

  const prompt = JSON.stringify({
    input,
    mode: ctx.mode,
    target: target ? { type: target.type, url: target.type === 'url' ? target.url : undefined, source: target.type === 'url' ? target.source : undefined } : null,
    project: ctx.projectName ? { name: ctx.projectName, path: ctx.projectPath } : null,
    lastAgentResult: ctx.lastAgentResult ? {
      task: ctx.lastAgentResult.task,
      intent: ctx.lastAgentResult.intent,
      summary: ctx.lastAgentResult.summary?.slice(0, 200),
      findings: ctx.lastAgentResult.findings?.slice(0, 5),
    } : null,
    lastExternalResource: ctx.lastExternalResource ? { url: ctx.lastExternalResource.url, title: ctx.lastExternalResource.title } : null,
    recentMessages: (ctx.recentMessages ?? []).slice(-5).map((m) => ({ role: m.role, content: m.content.slice(0, 100) })),
    pendingAction: ctx.pendingAction ?? null,
  });

  try {
    const raw = await client.chatJson(
      `你是意图路由器。根据输入和上下文输出 JSON，不要输出其他内容。\n` +
      `intent: command_help|command_exit|command_clear|command_status|command_model|command_sessions|command_resume|capability_question|small_talk|explain_project|audit_task|debug_task|code_task|test_task|config_task|conversation_summary|previous_result_question|continue_previous_task|webpage_summary|webpage_content_question|external_doc_question|url_safety_check|unknown\n` +
      `execution: local_action|llm_direct|llm_direct_limited|agent_readonly|agent_plan|agent_execute|url_fetch_pipeline\n` +
      `analysisDepth: none|overview|standard|deep\n` +
      `\n关键路由规则：\n` +
      `- audit_task = 审查项目/代码质量/优化建议/安全漏洞/技术债/CI配置/测试覆盖。execution=agent_readonly。\n` +
      `- explain_project = 解释项目结构/架构分析/文件说明。execution=agent_readonly。\n` +
      `- debug_task = 修复bug/类型错误/报错/测试失败/定位排查。execution=agent_readonly。只有输入包含具体错误(TS错误码/堆栈/报错信息)才用debug_task。\n` +
      `- code_task = 开发新功能/写代码/重构/生成文件。execution=agent_readonly 或 agent_plan。\n` +
      `- 如果 pendingAction 存在且用户说"继续"/"执行"/"接着": intent=continue_previous_task, execution=agent_plan\n` +
      `- 如果 input 包含 URL 或 target.type=url: intent=webpage_summary, execution=url_fetch_pipeline, shouldScanProject=false\n` +
      `- previous_result_question 仅用于纯记忆型提问("上面说了什么"/"刚才的结论是什么")。如果用户要求核实/对比/检查是否已修复/列出已修改项，这是 audit_task 需要读代码验证, 不是 previous_result_question。execution=agent_readonly。\n` +
      `- 能力询问/纯寒暄 → small_talk 或 capability_question, llm_direct, shouldScanProject=false\n` +
      `\n上下文: ${prompt}\n\n输出JSON:`,
    );

    // JSON 容错: 提取 markdown 代码块, 处理 Flash 非纯JSON输出
    let jsonStr = raw;
    const mdMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (mdMatch) jsonStr = mdMatch[1].trim();
    const parsed = JSON.parse(jsonStr);
    return {
      intent: parsed.intent ?? 'unknown',
      execution: parsed.execution ?? 'local_action',
      shouldScanProject: parsed.shouldScanProject ?? false,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      needsClarification: parsed.needsClarification ?? false,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reason: parsed.reason ?? 'LLM Router 判断',
      analysisDepth: parsed.analysisDepth ?? 'none',
    };
  } catch {
    return fallbackClarification(input);
  }
}

function fallbackClarification(input: string): RouteDecision {
  // 无 LLM Router 时的基础探测——不给具体 intent, 但给 Agent 工具
  const isAuditLike = /审查|优化|代码质量|安全漏洞|技术债|架构|分析.*项目/i.test(input);
  const isRepairLike = /TS\d+|报错|修复|类型错误|编译失败|测试失败|\.(ts|tsx):\d+/.test(input);
  const isExplainLike = /解释|说明|介绍|是什么|怎么工作/i.test(input);
  const isCiLike = /CI|ci|测试.*失败|会不会.*失败|构建|pipeline|workflow.*fail|github action/i.test(input);
  const isCompareVerify = /哪些.*已.*修复|哪些.*已.*改|对比.*之前|审查对比|检查.*是否.*修|列出.*已.*修改/i.test(input);

  return {
    intent: isRepairLike ? 'debug_task' : isAuditLike ? 'audit_task' : isCiLike ? 'audit_task' : isCompareVerify ? 'audit_task' : isExplainLike ? 'explain_project' : 'unknown',
    execution: 'agent_readonly',
    shouldScanProject: true,
    allowedTools: [],
    needsClarification: false,
    confidence: 0.35,
    reason: `LLM Router 不可用 → ${isRepairLike ? 'debug' : isAuditLike || isCiLike || isCompareVerify ? 'audit' : isExplainLike ? 'explain' : 'agent_readonly'}`,
  };
}

// ═══════════════════════════════════════
// Permission Guard — 最终权限裁决
// ═══════════════════════════════════════

// 工具名列表从 definitions.ts 动态生成（见文件顶部 import）
const READONLY_TOOLS = READ_ONLY_DEFS.map((t: { name: string }) => t.name);
const WRITE_TOOLS = WRITE_DEFS.map((t: { name: string }) => t.name);

export function normalizeRouteDecision(decision: RouteDecision, mode: 'readonly' | 'ask' | 'auto'): RouteDecision {
  const d = { ...decision };

  // local_action / llm_direct / llm_direct_limited 永远不允许工具和扫项目
  if (d.execution === 'local_action' || d.execution === 'llm_direct' || d.execution === 'llm_direct_limited') {
    d.shouldScanProject = false;
    d.allowedTools = [];
    d.analysisDepth = 'none';
    return d;
  }

  // url_fetch_pipeline: 只允许 web_fetch + web_search，不扫项目
  if (d.execution === 'url_fetch_pipeline') {
    d.shouldScanProject = false;
    d.allowedTools = ['web_fetch', 'web_search'];
    if (mode === 'readonly') {
      // readonly 下允许（fetch 是只读工具）
    }
    return d;
  }

  // readonly 模式：禁止写工具，降级 execution
  if (mode === 'readonly') {
    d.allowedTools = (d.allowedTools.length > 0 ? d.allowedTools : READONLY_TOOLS).filter((t) => !WRITE_TOOLS.includes(t));
    if (d.execution === 'agent_execute') d.execution = 'agent_plan';
    // readonly 下所有可能修改的操作降级为只读
    if (['code_task', 'debug_task', 'test_task', 'config_task'].includes(d.intent) && d.execution === 'agent_plan') {
      d.execution = 'agent_readonly';
    }
  }

  // ask 模式：写工具需确认
  if (mode === 'ask' && d.allowedTools.length === 0) {
    d.allowedTools = [...READONLY_TOOLS, ...WRITE_TOOLS];
  }

  // auto 模式：允许执行 + 升级为 agent_execute
  if (mode === 'auto') {
    if (d.allowedTools.length === 0) d.allowedTools = [...READONLY_TOOLS, ...WRITE_TOOLS];
    if (d.execution === 'agent_plan') d.execution = 'agent_execute';
  }

  return d;
}

// ═══════════════════════════════════════
// 主入口: Hybrid Router
// ═══════════════════════════════════════

export async function routeInput(
  input: string,
  ctx: RouterContext,
  llmClient?: LLMRouterClient,
): Promise<RouteDecision & { trace?: import('deepseek-code-shared').RouteTrace }> {
  const trace: import('deepseek-code-shared').RouteTrace = {
    commandRouterHit: false,
    heuristicRouterHit: false,
    llmRouterCalled: false,
  };

  // Layer 0: Command Router — CLI 命令不经过后续路由
  const cmdResult = commandRouter(input);
  if (cmdResult) {
    trace.commandRouterHit = true;
    trace.beforeGuardDecision = cmdResult;
    const final = normalizeRouteDecision(cmdResult, ctx.mode);
    trace.afterGuardDecision = final;
    return { ...final, trace };
  }

  // Layer 1: LLM Router — 主分类器（意图+Target一体，替代手写正则）
  if (llmClient) {
    trace.llmRouterCalled = true;
    const target = resolveTarget(input, ctx);
    try {
      const llmDecision = await llmRouter(input, ctx, llmClient, target);
      if (!llmDecision.reason?.includes('降级')) {
        trace.beforeGuardDecision = llmDecision;
        const targetGuarded = applyTargetGuard(llmDecision, target);
        const final = normalizeRouteDecision(targetGuarded, ctx.mode);
        trace.afterGuardDecision = final;
        return { ...final, trace };
      }
      trace.llmRouterFallbackReason = llmDecision.reason;
    } catch {
      trace.llmRouterFallbackReason = 'LLM Router 调用异常，降级 heuristic';
    }
    // LLM 失败 → 降级 heuristic
  }

  // Layer 2: Heuristic Router — 仅当无 LLM Client 时作为降级
  const heuristic = heuristicRouter(input, ctx);
  if (heuristic && heuristic.confidence >= 0.8) {
    trace.heuristicRouterHit = true;
    trace.beforeGuardDecision = heuristic;
    const final = normalizeRouteDecision(heuristic, ctx.mode);
    trace.afterGuardDecision = final;
    return { ...final, trace };
  }

  // 最终降级
  const fallback = fallbackClarification(input);
  trace.beforeGuardDecision = fallback;
  return { ...normalizeRouteDecision(fallback, ctx.mode), trace };
}

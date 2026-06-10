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
// Heuristic Router — 仅高置信度开发任务
// ═══════════════════════════════════════

function heuristicRouter(input: string, ctx: RouterContext): RouteDecision | null {
  const text = input.trim();

  // 短追问（"讲一下"/"详细点"）有 conversationFocus → Agent 读取对应文件
  if (ctx.conversationFocus?.file && /^(讲一下|详细|展开|说说|再讲|解释|具体|它是|怎么)/.test(text) && text.length <= 8) {
    return {
      intent: 'code_task', execution: 'agent_readonly',
      target: { type: 'file', path: ctx.conversationFocus.file },
      shouldScanProject: false,
      allowedTools: ['read_file', 'read_file_range'],
      needsClarification: false, confidence: 0.85,
      reason: `短追问 → focus: ${ctx.conversationFocus.label}`,
    };
  }

  // 极短追问（"讲一下"/"继续"/"详细点"）有上下文时 → LLM 自然回答
  if (ctx.lastAgentResult && text.length <= 5 && /^(讲一下|详细|继续|然后|接着|具体|说说|再讲|解释)/.test(text)) {
    return { intent: 'conversation_summary', execution: 'llm_direct', shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.85, reason: '短追问 + 有上下文 → LLM 直聊' };
  }

  // context-aware: 纯寒暄（短输入 + 匹配列表）
  if (/^(你好|hi|hello|hey|哈喽|在吗|早上好|下午好|晚上好)\s*$/i.test(text) && text.length < 10) {
    return { intent: 'small_talk', execution: 'llm_direct', shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.9, reason: '纯寒暄 → LLM 自然回答' };
  }

  // --- Target-aware 路由: URL / chat_history 由 Target Resolver 处理 ---
  const target = resolveTarget(text, ctx);
  if (target.type === 'url') {
    // source=explicit → 首轮 → webpage_summary (概述)
    // source=last_external_resource → 追问 → webpage_content_question / external_doc_question
    const urlIntent = target.source === 'explicit'
      ? (/安全|safe|check.*url|钓鱼/i.test(text) ? 'url_safety_check' as const : 'webpage_summary' as const)
      : (/接入|怎么.*用|支持.*模型|api|base.*url/i.test(text) ? 'external_doc_question' as const : 'webpage_content_question' as const);
    return applyTargetGuard({
      intent: urlIntent,
      execution: 'url_fetch_pipeline',
      shouldScanProject: false,
      allowedTools: [],
      needsClarification: false,
      confidence: 0.9,
      reason: `目标=URL(${target.source}): ${target.url.slice(0, 50)}`,
    }, target);
  }
  // (chat_history 目标由后续会话回顾规则处理，此处不提前返回)

  // project_component_question: "你现在的规划器是什么？"/"你的路由器是怎么实现的？"
  if (/你.*(规划器|路由器|安全层|audit.*pipeline|记忆.*存在|Agent.*Loop|扫描器|prompt.*build)/i.test(text) && text.length > 6) {
    return { intent: 'capability_question', execution: 'llm_direct', shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.8, reason: '项目组件自我解释 → LLM 直聊' };
  }

  // capability_question: 能力询问 → llm_direct 自然回答
  if (/你可以帮.*做|你能.*做|你能.*帮|可以做些什么|能做什么|有哪些功能|怎[么样]用|有哪些命令|介绍一下|你能干嘛|如何使用|使用教程|怎么使用|怎么用/i.test(text)) {
    return { intent: 'capability_question', execution: 'llm_direct', shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.85, reason: '能力询问 → LLM 自然回答' };
  }

  // 会话回顾（有 lastAgentResult 时）
  if (ctx.lastAgentResult && /上面.*(聊|说|讲|分析|提)|刚才.*(说|分析|讲|提)|总结.*刚才|回顾|你.*(说|分析).*(拆分|怎么|具体|展开)|核实|验证.*发现|确认.*(发现|行数|数目|数量|文件)|核查|有多少|几个/i.test(text)) {
    return { intent: 'conversation_summary', execution: 'llm_direct', shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.9, reason: '会话回顾/核实 → LLM 直聊' };
  }
  // URL上下文追问："刚才分析的URL文档里..."
  if (ctx.lastExternalResource && /刚才.*(URL|链接|网页|文档|分析)/i.test(text)) {
    return applyTargetGuard({
      intent: 'webpage_content_question', execution: 'url_fetch_pipeline', shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.8,
      reason: 'URL追问 → 继承lastExternalResource',
    }, { type: 'url', url: ctx.lastExternalResource.url, source: 'last_external_resource' });
  }

  // 继续任务
  if (ctx.pendingAction && /^(继续|按.*方案|执行|接着|go on|continue)\b/i.test(text)) {
    return { intent: 'continue_previous_task', execution: 'agent_plan', shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.85, reason: '继续任务 → pendingAction存在' };
  }
  if (!ctx.pendingAction && /^(继续|接着|go on|continue)\b/i.test(text) && text.length < 8) {
    return { intent: 'continue_previous_task', execution: 'llm_direct', shouldScanProject: false, allowedTools: [], needsClarification: true, confidence: 0.5, reason: '继续？但无pendingAction' };
  }
  // ⚠️ 顺序关键：debug/code/test 必须在 explain_project 之前
  // debug_task: 修复/排查/为什么+问题
  if (hasPair(text, /修复|解决|排查|debug|fix|为什么|怎么.*(报错|失败)/i, /bug|报错|失败|错误|无法|不生效|跳转|构建|test|类型|type|解析|异常|慢/i) && text.length > 5) {
    return { intent: 'debug_task', execution: 'agent_plan', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.85, reason: '命中: debug_task' };
  }
  // debug_task: 检查特定函数/文件是否有问题（不触发 audit_task 全项目审查）
  if (/(检查|审查|看看|查查).{0,30}(函数|方法|模块|文件|代码|安全边界|漏洞|死代码|引用|配置)/i.test(text) && text.length > 8 && !/项目|全项目|代码质量|架构/i.test(text)) {
    return { intent: 'debug_task', execution: 'agent_plan', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.8, reason: '命中: debug_task(定向检查)' };
  }
  // debug_task: 报错信息中包含 TS 错误码或文件:行号
  if (/error\s+TS\d+|\.(ts|tsx):\d+:\d+|根据.*报错|定位.*文件|排查.*错误/i.test(text) && text.length > 15) {
    return { intent: 'debug_task', execution: 'agent_plan', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.85, reason: '命中: debug_task(错误定位)' };
  }

  // 简短 debug + English
  if (/^(修复|fix|debug|排查)\s+\S+/i.test(text) || /fix\s+(a\s+)?(bug|error|issue)/i.test(text)) {
    return { intent: 'debug_task', execution: 'agent_plan', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.8, reason: '命中: debug_task(短)' };
  }

  // code_task: 开发动作 + 明确目标
  if (hasPair(text, /新增|添加|创建|实现|重构|接入|增加|开发/i, /页面|功能|接口|组件|模块|CLI|路由|端点|endpoint|中间件|类型|包/i)) {
    return { intent: 'code_task', execution: 'agent_plan', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.85, reason: '命中: code_task' };
  }
  // 代码修改类（单关键词 + 英文）
  if (/修改.*(文件|配置|代码)|写.*(页面|组件|模块|接口|代码|注释)|给.*加.*(注释|功能)|optimize|refactor|implement|add\s+(a\s+)?new|add\s+user|add\s+api/i.test(text)) {
    return { intent: 'code_task', execution: 'agent_plan', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.8, reason: '命中: code_task(单关键词)' };
  }

  // debug_task: 运行验证命令
  if (/运行\s+(pnpm|npm|yarn|npx)?\s*(typecheck|lint|build|test|vitest)/i.test(text)) {
    return { intent: 'debug_task', execution: 'agent_plan', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.85, reason: '命中: debug_task(运行验证)' };
  }

  // test_task
  if (/写.*测试|编写.*测试|补充.*测试|单元测试|集成测试|vitest|coverage|run.*test|write.*test/i.test(text)) {
    return { intent: 'test_task', execution: 'agent_plan', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.85, reason: '命中: test_task' };
  }

  // git diff review: "检查 git diff", "diff 有什么问题", "看看改了哪些文件"
  if (/(git\s+)?diff.*(检查|问题|有没有|怎么样|review|有问题|看了|看看)|检查.*(git\s+)?diff|看看.*(git\s+)?diff|diff.*check/i.test(text)) {
    return { intent: 'command_status', execution: 'llm_direct', shouldScanProject: false, allowedTools: [], needsClarification: false, confidence: 0.85, reason: 'git diff 检查 → llm_direct' };
  }

  // audit_task: 检查/审查/审计 → verified audit pipeline
  // 标准长度 (>8字)
  if (hasPair(text, /检查|审查|审计|漏洞|安全|优化/i, /项目|代码|安全|质量|缺陷|架构|技术债/i) && text.length > 8) {
    return { intent: 'audit_task', execution: 'agent_readonly', shouldScanProject: true, allowedTools: ['read_json_path', 'list_scripts', 'detect_cross_platform', 'file_exists', 'find_references', 'read_file', 'search_code'], needsClarification: false, confidence: 0.8, reason: '命中: audit_task → audit_pipeline' };
  }
  // 短但明确的安全/审计请求 (5-8字): "检查安全漏洞", "审查代码质量"
  if (/^(检查|审查|审计)(安全漏洞|代码质量|代码规范|依赖安全|项目安全|项目质量)/.test(text) && text.length >= 5 && text.length <= 8) {
    return { intent: 'audit_task', execution: 'agent_readonly', shouldScanProject: true, allowedTools: ['read_json_path', 'list_scripts', 'detect_cross_platform', 'file_exists', 'find_references', 'read_file', 'search_code'], needsClarification: false, confidence: 0.85, reason: '命中: audit_task → audit_pipeline' };
  }

  // explain_file: "讲一下 XXX.ts/XXX 是怎么工作的"
  if (/(讲一下|说说|解释|展开)\s+(\S+\.(?:ts|tsx|js|json)|[a-zA-Z_]+\s*(?:函数|模块|类|组件|文件))/i.test(text) && text.length >= 5) {
    return { intent: 'explain_project', execution: 'agent_readonly', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.8, reason: '命中: explain_file → 组件解释' };
  }

  // explain_project: 项目分析/检查/审查（最宽，放在最后）
  // 单关键词强信号
  if (/^(解释|分析|审查|检查|审计)\s*(这个|一下|项目|代码|文件|模块|依赖|配置)/i.test(text) && text.length >= 5) {
    return { intent: 'explain_project', execution: 'agent_readonly', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.85, reason: '命中: explain_project(强)' };
  }
  // explain + English
  if (/^explain\s+(this|the|project|code|file)/i.test(text)) {
    return { intent: 'explain_project', execution: 'agent_readonly', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.85, reason: '命中: explain_project(EN)' };
  }
  // 双关键词（扩展目标组覆盖更多对象词）
  if (hasPair(text, /解释|分析|看看|了解|梳理|检查|审查|审计|缺陷|漏洞|安全|优化/i, /项目|架构|结构|代码|repo|模块|依赖|配置|质量|这个|文件|干嘛|做|什么|作用|安全|性能/i) && text.length >= 6) {
    const depth = /全面|深入|完整|详细|deep/i.test(text) ? 'deep' : /解释|分析|架构|结构/i.test(text) ? 'standard' : 'overview';
    return { intent: 'explain_project', execution: 'agent_readonly', shouldScanProject: true, allowedTools: [], needsClarification: false, confidence: 0.8, reason: `命中: explain_project (${depth})`, analysisDepth: depth };
  }

  return null; // fallback to LLM Router
}

function hasPair(text: string, a: RegExp, b: RegExp): boolean {
  return a.test(text) && b.test(text);
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
      `intent: command_help|command_exit|command_clear|command_status|command_model|command_sessions|command_resume|capability_question|small_talk|explain_project|debug_task|code_task|test_task|config_task|conversation_summary|previous_result_question|continue_previous_task|webpage_summary|webpage_content_question|external_doc_question|url_safety_check|unknown\n` +
      `execution: local_action|llm_direct|llm_direct_limited|agent_readonly|agent_plan|agent_execute|url_fetch_pipeline\n` +
      `analysisDepth: none|overview|standard|deep\n` +
      `\n先判断 target，再判断 intent：\n` +
      `- 如果 pendingAction 存在且用户说"继续"/"执行"/"接着": intent=continue_previous_task, execution=agent_plan\n` +
      `- 如果 input 包含 URL 或 target.type=url: intent=webpage_summary/webpage_content_question, execution=url_fetch_pipeline, shouldScanProject=false\n` +
      `- 如果 input 引用上轮 URL("这个网页"/"上面的链接")且 lastExternalResource 存在: target.type=url(source=last_external_resource), execution=url_fetch_pipeline\n` +
      `- 只有在 target.type=workspace 时才能路由到 explain_project/debug_task/code_task\n` +
      `- 能力询问/纯寒暄 → local_action 或 llm_direct, shouldScanProject=false\n` +
      `- 如果没有 web_fetch 能力且 target.type=url: execution=llm_direct_limited, needsClarification=true\n` +
      `\n上下文: ${prompt}\n\n输出JSON:`,
    );

    const parsed = JSON.parse(raw);
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
  return {
    intent: 'unknown',
    execution: 'llm_direct',  // 走自然对话澄清，绝不 local_action
    shouldScanProject: false,
    allowedTools: [],
    needsClarification: true,
    confidence: 0.2,
    reason: `LLM Router 降级: ${input.slice(0, 30)}`,
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

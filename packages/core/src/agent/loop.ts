// ============================================================
// Agent Runtime — 主循环
// ============================================================

import type { ChatMessage, Session, AgentStep, ToolCall, ExecutionPlan, ToolExecutionResult } from 'deepseek-code-shared';
import { canTransitionPhase, fileFingerprint, MODEL_PRO, MODEL_FLASH } from 'deepseek-code-shared';
import type { AgentPhase } from 'deepseek-code-shared';
import { generateSessionId, estimateTaskComplexity, recommendModel } from 'deepseek-code-shared';
import type { ModelClient } from '../model/types.js';
import { ModelRouter } from '../model/router.js';
import type { ToolExecutors } from '../tools/executors.js';
import { executeTool, createToolExecutors, createFailureBudget, type ToolFailureBudget } from '../tools/executors.js';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../tools/definitions.js';
import type { MemoryStore } from '../context/memory.js';
import { createStep } from '../context/memory.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanRepo, buildRepoSummary } from '../context/scanner.js';
import { buildPrompt, compressSessionForResume, type PromptHashes } from '../context/prompt-builder.js';
import { parsePlanJson, generatePlan } from './planner.js';
import type { PermissionManager } from '../safety/permissions.js';

/** 安全的 phase 迁移 — 非法迁移时记录 warning 并允许（兼容旧 session） */
function setPhase(session: Session, to: AgentPhase, source: string): void {
  const from = session.phase ?? 'initializing';
  if (!canTransitionPhase(from, to)) {
    console.warn(`⚠️ 非法 Phase 迁移: ${from} → ${to} (${source})，允许但请检查`);
  }
  session.phase = to;
}

export interface AgentConfig {
  workingDir: string;
  router: ModelRouter;
  tools: ToolExecutors;
  memory: MemoryStore;
  maxSteps?: number;
  readOnly?: boolean;
  permissionManager?: PermissionManager;
  onConfirm?: (message: string) => Promise<boolean>;
  streaming?: boolean;
  /** 恢复指定会话 ID（跳过计划阶段，直接继续执行） */
  resumeSessionId?: string;
  /** KV Cache 策略: 控制上下文注入级别 */
  contextPolicy?: 'none' | 'session_state' | 'project_summary' | 'project_slices' | 'full_agent';
}

export interface AgentResult {
  session: Session;
  success: boolean;
  summary: string;
  error?: string;
}

/**
 * DeepSeek Code Agent 主循环
 *
 * 流程：
 * 1. 扫描项目 → 2. 加载规则 → 3. 生成计划 → 4. 执行计划 → 5. 输出总结
 */
export async function runAgentLoop(
  taskDescription: string,
  config: AgentConfig,
): Promise<AgentResult> {
  const { workingDir, router, tools, memory, maxSteps = 20, readOnly = true, permissionManager, streaming = true, resumeSessionId } = config;
  const startTime = Date.now();

  // ========== 恢复模式 ==========
  if (resumeSessionId) {
    const loaded = await memory.loadSession(resumeSessionId);
    if (!loaded) {
      return { session: null as unknown as Session, success: false, summary: `会话 ${resumeSessionId} 不存在`, error: 'not_found' };
    }

    const phase = loaded.phase ?? 'analyzing';
    console.log(`🔄 恢复会话: ${loaded.id}`);
    console.log(`📋 任务: ${loaded.taskDescription.slice(0, 60)}`);
    console.log(`🔁 阶段: ${phase}  📊 已执行 ${loaded.steps.length} 步`);

    if (loaded.completed) {
      console.log(`✅ 此会话已完成，无需恢复\n`);
      return { session: loaded, success: true, summary: '会话已完成，无需恢复' };
    }
    if (loaded.workingDir !== workingDir) {
      console.log(`❌ 工作目录不匹配: ${loaded.workingDir} ≠ ${workingDir}\n`);
      return { session: loaded, success: false, summary: `工作目录不匹配`, error: 'dir_mismatch' };
    }

    const resumeModel = router.getClient(loaded.modelName as typeof MODEL_PRO | typeof MODEL_FLASH);
    const availableTools = readOnly ? READ_ONLY_TOOLS : [...READ_ONLY_TOOLS, ...WRITE_TOOLS];

    if (loaded.interruptionReason) console.log(`💡 中断原因: ${loaded.interruptionReason}`);
    console.log('');

    // Workspace 校验：对比已知文件的新旧指纹
    const staleFiles: string[] = [];
    const freshFiles: string[] = [];
    for (const f of loaded.knownFiles ?? []) {
      const fullPath = path.resolve(workingDir, f);
      const currentFp = fileFingerprint(fullPath);
      // 在 cache 中查找该文件的所有历史条目
      const oldEntries = Object.entries(loaded.toolResultsCache ?? {}).filter(([key]) => key.includes(`read:${f}:`));
      if (oldEntries.length === 0) continue; // 无历史缓存，跳过

      const oldFp = oldEntries[0][0].split(`read:${f}:`)[1]; // 提取旧指纹
      if (oldFp && oldFp !== currentFp) {
        staleFiles.push(f);
      } else if (oldFp === currentFp) {
        freshFiles.push(f);
      }
    }
    if (staleFiles.length > 0) {
      console.log(`⚠️ ${staleFiles.length} 个文件已变化: ${staleFiles.slice(0, 5).join(', ')}`);
    }
    if (freshFiles.length > 0) {
      console.log(`💾 ${freshFiles.length} 个文件未变，将复用缓存`);
    }
    loaded.staleFiles = staleFiles;

    // 构建工具缓存 Map
    const toolCache = new Map<string, import('deepseek-code-shared').ToolExecutionResult>();
    if (loaded.toolResultsCache) {
      for (const [key, entry] of Object.entries(loaded.toolResultsCache)) {
        if (entry?.result) toolCache.set(key, entry.result);
      }
    }

    // 压缩 session 状态（不全量回放历史消息）
    const compressed = compressSessionForResume(loaded);

    // 重建消息上下文（用 PromptBuilder 稳定前缀）
    const repoInfo = loaded.repoInfo ?? { name: workingDir, rootDir: workingDir, techStack: { language: 'Unknown', framework: null, buildTool: 'unknown', packageManager: 'unknown', runtime: 'Node.js', uiLibrary: null, orm: null, testFramework: null }, structure: { hasSrcDir: false, entryFiles: [], routeFiles: [], configFiles: [], keyDirectories: [] }, rules: { agentsMd: null, readme: null, packageJson: null, eslintConfig: null, tsconfig: null } };
    const resumePrompt = buildPrompt({
      repoInfo: repoInfo as import('deepseek-code-shared').RepoInfo,
      task: compressed.task,
      plan: compressed.plan,
      phase: compressed.phase,
      knownFiles: compressed.knownFiles,
      mode: loaded.mode ?? 'readonly',
      userInput: `[会话恢复] 已应用 ${compressed.appliedPatches.length} 个补丁。近期工具结果:\n${compressed.recentToolResults.slice(0, 5000)}\n\n上次结论: ${compressed.lastFindings.slice(0, 2000)}\n\n可用工具: ${availableTools.map((t) => t.name).join(', ')}。请基于已有信息继续。`,
    });
    logPrefixHashes(resumePrompt.hashes);

    const messages: ChatMessage[] = [
      { role: 'system', content: resumePrompt.layers.globalPrefix + '\n\n' + resumePrompt.layers.runtimePrefix + '\n\n' + resumePrompt.layers.projectPrefix + '\n\n' + resumePrompt.layers.sessionPrefix + '\n\n' + resumePrompt.layers.dynamicTail },
    ];

    // 只重建计划 + 摘要（不全量回放）
    const planStep = loaded.steps.find((s) => s.type === 'planning');
    if (planStep) {
      messages.push({ role: 'user', content: loaded.taskDescription + '\n\n' + planStep.content });
    }

    // 最后一个 final/thinking 步骤作为上下文
    const lastThinking = [...loaded.steps].reverse().find((s) => s.type === 'final' || s.type === 'thinking');
    if (lastThinking) {
      messages.push({ role: 'assistant', content: lastThinking.content.slice(0, 2000) });
    }

    // 恢复指令
    const toolList = availableTools.map((t) => t.name).join(', ');
    messages.push({
      role: 'user',
      content: `[会话恢复] 阶段: ${phase}。模式: ${loaded.mode ?? 'readonly'}。之前已执行 ${loaded.steps.filter((s) => s.type === 'tool_call').length} 步。已知文件: ${(loaded.knownFiles ?? []).slice(0, 20).join(', ')}。已应用补丁: ${(loaded.appliedPatches ?? []).length} 个。可用工具: ${toolList}。请基于已有信息继续，不要重复读取未变化文件。`,
    });

    // 注入 toolCache 到工具执行器
    const resumeTools = createToolExecutors({ workingDir, toolCache, isResume: true });

    return continueLoop(loaded, messages, resumeModel, availableTools, workingDir, resumeTools, memory, permissionManager, readOnly, streaming, startTime, maxSteps, config.onConfirm);
  }

  // ========== 正常模式 ==========
  const modelName = router.selectModel(taskDescription);
  const model = router.getClient(modelName);
  const availableTools = readOnly ? READ_ONLY_TOOLS : [...READ_ONLY_TOOLS, ...WRITE_TOOLS];

  // 创建会话
  const session: Session = {
    id: generateSessionId(),
    createdAt: new Date(),
    taskDescription,
    modelName,
    workingDir,
    steps: [],
    completed: false,
    phase: 'initializing',
    mode: (readOnly ? 'readonly' : 'ask') as import('deepseek-code-shared').AgentMode,
    appliedPatches: [],
    commandHistory: [],
    knownFiles: [],
    toolResultsCache: {},
  };

  console.log(`🤖 DeepSeek Code Agent v0.1 启动`);
  console.log(`📁 ${workingDir}`);
  console.log(`🧠 ${modelName}  🔒 ${readOnly ? '只读' : '读写'}  📡 ${streaming ? '流式' : '普通'}`);
  console.log('');

  try {
    // 4. 扫描项目 — 按 contextPolicy 控制
    const skipScan = config.contextPolicy === 'none' || config.contextPolicy === 'session_state';
    let repoInfo: import('deepseek-code-shared').RepoInfo;
    let repoSummary = '';
    if (skipScan) {
      console.log('⚡ 免扫描模式（contextPolicy: none/session_state）');
      repoInfo = {
        name: path.basename(workingDir), rootDir: workingDir,
        techStack: { language: 'Unknown', framework: null, buildTool: 'unknown', packageManager: 'unknown', runtime: 'Node.js', uiLibrary: null, orm: null, testFramework: null },
        structure: { hasSrcDir: false, entryFiles: [], routeFiles: [], configFiles: [], keyDirectories: [] },
        rules: { agentsMd: null, readme: null, packageJson: null, eslintConfig: null, tsconfig: null },
        git: undefined,
      };
    } else {
      const scanStart = Date.now();
      process.stdout.write('🔍 扫描项目... ');
      repoInfo = await scanRepo({ workingDir });
      session.repoInfo = repoInfo;
      repoSummary = buildRepoSummary(repoInfo);
      console.log(`✅ (${Date.now() - scanStart}ms) → ${repoInfo.techStack.language}${repoInfo.techStack.framework ? ' + ' + repoInfo.techStack.framework : ''}`);
      console.log('');
    }

    // 5. 生成计划（流式输出）—— full_agent 注入轻量 repo index（非完整 RepoMap）
    const planStart = Date.now();
    process.stdout.write('📋 生成计划... ');
    const isAuditTask = /审查|审计|分析.*架构|检查.*代码/i.test(taskDescription);
    const needsRichContext = config.contextPolicy === 'full_agent' || config.contextPolicy === 'project_summary';
    let richContext = repoSummary;
    if (needsRichContext && repoInfo.structure.keyDirectories.length > 0) {
      // 轻量 index: 目录→入口文件→关键模块，替代完整 RepoMap
      const indexLines = [
        '\n## 项目索引 (轻量)',
        `目录: ${repoInfo.structure.keyDirectories.sort().join(', ')}`,
        `入口: ${[...repoInfo.structure.entryFiles].sort().join(', ')}`,
        repoInfo.structure.configFiles.length > 0 ? `配置: ${repoInfo.structure.configFiles.sort().join(', ')}` : '',
      ].filter(Boolean);
      if (isAuditTask && config.contextPolicy === 'full_agent') {
        indexLines.push(
          '',
          '审计提示: 请按以下顺序读取关键文件——',
          '1. package.json / tsconfig → 理解项目配置',
          '2. 入口文件 → 理解核心逻辑',
          '3. 安全/权限/认证模块 → 如存在',
          '4. 数据流/路由层 → 追踪外部输入',
          '避免盲目扫描全项目。优先聚焦上述文件。',
        );
      }
      richContext = repoSummary + '\n' + indexLines.join('\n');
      const ctxSize = richContext.length;
      console.log(`📊 上下文: ${(ctxSize/1000).toFixed(0)}K (summary+index)`);
    }
    const auditSeed = isAuditTask && config.contextPolicy === 'full_agent'
      ? await buildAuditSeedContext(tools, workingDir)
      : { context: '', sequence: [] as string[] };
    if (auditSeed.context) {
      richContext += `\n\n${auditSeed.context}`;
      (session as any).__auditSeedToolSequence = auditSeed.sequence;
      console.log(`🎯 Audit seed: ${auditSeed.sequence.join(' → ')}`);
    }

    const isRepairTask = /报错|异常|失败|堆栈|stack trace|TS\d+|Cannot find module|TypeError|ReferenceError|SyntaxError|运行时错误|崩溃|crash|解析失败|JSON.*无效|配置.*无效|配置解析/i.test(taskDescription) && !isAuditTask;
    const repairSeed = isRepairTask && config.contextPolicy !== 'none'
      ? await buildRepairSeedContext(taskDescription, tools, workingDir)
      : { context: '', sequence: [] as string[] };
    if (repairSeed.context) {
      richContext += `\n\n${repairSeed.context}`;
      (session as any).__auditSeedToolSequence = repairSeed.sequence;
      console.log(`🔧 Repair seed: ${repairSeed.sequence.join(' → ')}`);
    }

    const planResult = await generatePlanWithStreaming(router.flash, repoInfo, taskDescription, richContext, streaming, readOnly ? 'readonly' : 'ask');
    const plan = planResult.plan;
    const planMs = Date.now() - planStart;
    const stepsShown = planResult.shownCount;
    console.log(`⏱ 计划生成: ${(planMs / 1000).toFixed(1)}s`);
    session.steps.push(createStep(0, 'planning', formatPlan(plan)));
    // 流式没抓到步骤时兜底输出
    if (!streaming || stepsShown === 0) {
      console.log(formatPlan(plan));
    }
    console.log('');

    // 6. 用户确认计划
    if (config.onConfirm) {
      const approved = await config.onConfirm('是否按此计划执行？（Y/n）');
      if (!approved) {
        console.log('❌ 用户取消');
        session.completed = true;
        session.summary = '用户取消执行';
        await memory.saveSession(session);
        return { session, success: false, summary: '用户取消' };
      }
    }

    // 构建 prompt（四层稳定前缀，提升缓存命中率）
    const promptResult = buildPrompt({
      repoInfo,
      task: taskDescription,
      plan,
      phase: session.phase,
      knownFiles: session.knownFiles,
      mode: readOnly ? 'readonly' : 'ask',
      userInput: auditSeed.context ? `${taskDescription}\n\n${auditSeed.context}` : taskDescription,
    });
    logPrefixHashes(promptResult.hashes);
    (session as any).__prefixHashes = promptResult.hashes;
    (session as any).__contextPolicy = config.contextPolicy ?? 'full_agent';

    const messages: ChatMessage[] = [
      { role: 'system', content: promptResult.layers.globalPrefix + '\n\n' + promptResult.layers.runtimePrefix + '\n\n' + promptResult.layers.projectPrefix + '\n\n' + promptResult.layers.sessionPrefix + '\n\n' + promptResult.layers.dynamicTail },
    ];

    // 修复完成度复核：收敛到 runFixVerificationFlow()
    const { runFixVerificationFlow: runFVFlow } = await import('../tools/fix-verification.js');
    const fvFlow = await runFVFlow({ session, workingDir, taskDescription, memory });
    if (fvFlow) {
      session.__fvResult = fvFlow.fvResult as unknown as Record<string, unknown>;
      session.__fvTrend = fvFlow.trendLines;
      messages.unshift(fvFlow.systemMessage!);
    }

    // 8. 进入执行循环
    return continueLoop(session, messages, model, availableTools, workingDir, tools, memory, permissionManager, readOnly, streaming, startTime, maxSteps, config.onConfirm);
  } catch (e) {
    const errorMsg = String(e);
    console.error(`❌ Agent 执行异常: ${errorMsg}`);
    session.summary = `异常终止: ${errorMsg}`;
    session.phase = 'failed';
    session.interruptionReason = errorMsg.slice(0, 200);
    await memory.saveSession(session);
    return { session, success: false, summary: `异常终止: ${errorMsg}`, error: errorMsg };
  }
}

// ============================================================
// 执行循环（正常和 resume 共用）
// ============================================================

export async function continueLoop(
  session: Session,
  messages: ChatMessage[],
  model: ModelClient,
  availableTools: import('deepseek-code-shared').ToolDefinition[],
  workingDir: string,
  tools: ToolExecutors,
  memory: MemoryStore,
  permissionManager: PermissionManager | undefined,
  readOnly: boolean,
  streaming: boolean,
  startTime: number,
  maxSteps: number,
  onConfirm: ((message: string) => Promise<boolean>) | undefined,
): Promise<AgentResult> {
  let stepIndex = 0;
  let taskComplete = false;
  let noProgressRounds = 0;
  let lastReadFiles = new Set<string>();
  const failureBudget = createFailureBudget();
  const toolCtx: import('../tools/executors.js').ToolContext = {
    workingDir,
    mode: readOnly ? 'readonly' : 'ask',
    failureBudget,
  };

  // 设置当前阶段
  if (!session.phase || session.phase === 'initializing' || session.phase === 'planning') {
    session.phase = 'analyzing';
  }
  // 恢复模式显示阶段
  if (session.steps.length > 0 && session.interruptionReason) {
    console.log(`📍 阶段: ${session.phase}  💡 上次中断: ${session.interruptionReason}\n`);
  }

  // KV Cache 累计统计
  const auditSeedSequence = ((session as any).__auditSeedToolSequence as string[] | undefined) ?? [];
  const toolSequence = [...auditSeedSequence];
  let totalPrompt = 0, totalCache = 0, totalCacheMiss = 0, totalCompletion = 0, flashCalls = 0, proCalls = 0, toolCallCount = auditSeedSequence.length;
  const modelCalls: import('deepseek-code-shared').ModelCallStats[] = [];

  try {
    while (stepIndex < maxSteps && !taskComplete) {
      stepIndex++;

      // 8 轮后催促输出
      if (stepIndex >= 8 && !taskComplete && messages[messages.length - 1]?.role !== 'user') {
        messages.push({
          role: 'user',
          content: `[系统提示] 你已执行 ${stepIndex} 轮工具调用，信息足够。请直接输出分析结论，不要再读文件。`,
        });
      }

      // 审计首轮预防: 在模型调用前注入工具策略提示
      if (stepIndex === 1 && (session as any).__contextPolicy === 'full_agent' && /审查|审计/i.test(session.taskDescription)) {
        messages.push({
          role: 'user',
          content: '请先基于已注入的 seed context (package.json/rules/git status/diff) 使用 search_code 按关键词定位目标文件，然后 read_file 读取。不要先用 glob/list_files 全仓列目录。',
        });
      }

      // DeepSeek V4: 审查/审计任务提升推理深度
      const isAudit = /审查|审计|检查.*优化|代码质量|安全.*漏洞|架构.*问题/i.test(session.taskDescription);
      // 流式输出思考过程, tool_calls 缓冲后返回完整响应
      const callStart = Date.now();
      const response = await model.chatWithStreamingText(messages, {
        tools: availableTools,
        temperature: 0.3,
        reasoningEffort: isAudit ? 'medium' : undefined,
        toolChoice: 'auto',
      });
      const callLatency = Date.now() - callStart;

      // 模型调用统计
      const isFlash = model.modelName.includes('flash');
      if (isFlash) flashCalls++; else proCalls++;
      const modelTier = isFlash ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
      const perCallCost = calcCallCost(modelTier, response.usage);
      modelCalls.push({
        model: modelTier,
        route: (session as any).__contextPolicy ?? 'full_agent',
        contextPolicy: (session as any).__contextPolicy ?? 'full_agent',
        prefixHashes: (session as any).__prefixHashes ? {
          global: (session as any).__prefixHashes.globalPrefixHash,
          runtime: (session as any).__prefixHashes.runtimePrefixHash,
          project: (session as any).__prefixHashes.projectPrefixHash,
          session: (session as any).__prefixHashes.sessionPrefixHash,
        } : undefined,
        usage: {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          cacheHitTokens: response.usage.cache_hit_tokens ?? 0,
          cacheMissTokens: response.usage.cache_miss_tokens ?? (response.usage.prompt_tokens - (response.usage.cache_hit_tokens ?? 0)),
        },
        latencyMs: callLatency,
        costUsd: perCallCost,
        toolSequence: [...toolSequence],
      });
      totalPrompt += response.usage.prompt_tokens;
      totalCache += response.usage.cache_hit_tokens ?? 0;
      totalCacheMiss += response.usage.cache_miss_tokens ?? (response.usage.prompt_tokens - (response.usage.cache_hit_tokens ?? 0));
      totalCompletion += response.usage.completion_tokens;
      const cacheInfo = response.usage.cache_hit_tokens
        ? ` | 缓存: ${((response.usage.cache_hit_tokens / response.usage.prompt_tokens) * 100).toFixed(0)}%`
        : '';
      console.log(`📊 ${response.usage.prompt_tokens}+${response.usage.completion_tokens} tokens${cacheInfo}`);

      if (response.finish_reason === 'stop' && !response.tool_calls) {
        let finalContent = response.content ?? '';
        // 空响应兜底
        if (!finalContent.trim()) {
          messages.push({ role: 'user', content: '你的上一条回复是空的。请基于已读取的文件输出分析结论。' });
          continue;
        }

        // 后置门禁: 复用 report-validator 纯函数校验
        const { validateReportAnchors, buildRetryPrompt } = await import('./report-validator.js');
        const isReportLike = /审查|分析|报告|发现|问题|优化|安全|风险|架构|建议|审计/i.test(session.taskDescription) || finalContent.length > 500;
        const alreadyRetried = session.interruptionReason === 'retry_gate';

        if (isReportLike && !alreadyRetried) {
          const v = validateReportAnchors(finalContent, session.knownFiles, { allowShortAnswer: true, findings: session.findings });
          if (!v.valid) {
            session.interruptionReason = 'retry_gate';
            messages.push({ role: 'user', content: buildRetryPrompt(v) });
            continue;
          }
        }
        // 从最终报告中提取结构化 Finding（供 fix-verification 复用）
        if (isReportLike && finalContent.length >= 200) {
          try {
            const { extractFindingsFromReport: extr, mergeFindings: mergeF } = await import('../tools/fix-verification.js');
            const incoming = extr(finalContent, session.id.slice(0, 12));
            session.findings = mergeF(session.findings, incoming);
          } catch { /* 提取失败不影响主流程 */ }
        }

        session.steps.push(createStep(stepIndex, 'final', finalContent));
        messages.push({ role: 'assistant', content: finalContent });

        // 两阶段输出：足够多的工具调用后，先给摘要再给详情
        // fix-verification 任务跳过 Phase2——结构化结果已在 summary 中
        const canTwoPhase = streaming && stepIndex >= 3 && messages.length > 6 && !session.__fvResult;

        if (canTwoPhase) {
          console.log(`\n⚡ 两阶段输出 (前缀复用 KV Cache)：\n`);

          // Phase 1: 核心摘要（轻量级，快速返回）
          process.stdout.write('🔑 ');
          const phase1Start = Date.now();
          messages.push({ role: 'user', content: '基于以上全部分析，先输出1-2句最关键的发现或结论，不超过80字。只输出结论本身，不要说"基于分析"之类的废话。' });
          let phase1Summary = '';
          try {
            for await (const chunk of model.chatStream(messages, { temperature: 0.3, maxTokens: 300, disableThinking: true })) {
              process.stdout.write(chunk);
              phase1Summary += chunk;
            }
            process.stdout.write('\n\n');
          } catch {
            process.stdout.write(finalContent.slice(0, 300) + '\n\n');
            phase1Summary = '';
          }
          if (!phase1Summary.trim()) phase1Summary = finalContent.slice(0, 300);
          messages.push({ role: 'assistant', content: phase1Summary });
          const phase1Ms = Date.now() - phase1Start;

          // Phase 2: 详细报告（前缀稳定 → KV Cache 命中）
          // 瘦身: 不传完整工具结果，只传 system prompt + Phase1 + findings + knownFiles
          process.stdout.write('📋 详细分析:\n');
          const phase2Start = Date.now();
          const phase2SystemMsg = messages[0] as ChatMessage; // 稳定前缀 system message
          const findingsCtx = session.findings?.length
            ? `\n已知发现:\n${session.findings.slice(0, 20).map((f: any) => `- ${f.file || '?'}:${f.line || '?'} ${f.description || f}`).join('\n')}`
            : '';
          const knownFilesCtx = session.knownFiles?.length
            ? `\n已读文件 (${session.knownFiles.length}): ${session.knownFiles.slice(0, 30).join(', ')}`
            : '';
          const phase2Messages: ChatMessage[] = [
            phase2SystemMsg,
            { role: 'assistant' as const, content: phase1Summary || '分析完成' },
            { role: 'user' as const, content: `输出分析报告。只基于已读文件和已知发现。\n\n🔴 优先修复 (P0:运行时故障/安全漏洞, 最多3条)\n🟡 短期改进 (P1:回归风险/技术债, 最多3条)\n🟢 长期优化 (P2:架构改进, 最多3条)\n⚪ 风格建议 (P3:代码规范, 最多2条)\n\n铁律1: 每条写 [文件:行号]。只引用已读文件。\n铁律2: P0/P1写验证方式。推测降P2+[未验证]。\n铁律3: 同类归并。\n铁律4: 无内容写"无"。\n${findingsCtx}${knownFilesCtx}` },
          ];

          // Phase2 生成
          const { validateReportAnchors: v2, buildRetryPrompt: b2, buildDegradedReport: d2 } = await import('./report-validator.js');
          let phase2Text = await streamPhase2Once();
          let phase2Valid = v2(phase2Text, session.knownFiles, { allowShortAnswer: false, findings: session.findings });

          if (!phase2Valid.valid && phase2Text.trim()) {
            process.stdout.write('  ⚠️ 校验未通过，正在重写...\n');
            phase2Messages.push({ role: 'user' as const, content: b2(phase2Valid) });
            phase2Text = await streamPhase2Once();
            const retryV = v2(phase2Text, session.knownFiles, { allowShortAnswer: false, findings: session.findings });
            if (!retryV.valid && phase2Text.trim()) {
              console.log('⚠️ Phase2 两次校验不合格，输出降级报告');
              phase2Text = d2(session.knownFiles, phase1Summary);
            }
          }
          process.stdout.write(phase2Text + '\n');

          async function streamPhase2Once(): Promise<string> {
            let text = '';
            try {
              for await (const chunk of model.chatStream(phase2Messages, { temperature: 0.3, maxTokens: 2048, disableThinking: true })) {
                text += chunk;
              }
            } catch {
              text = finalContent;
            }
            return text;
          }

          // Phase2 空内容兜底
          if (!phase2Text.trim()) {
            console.log('⚠️ Phase2 无输出，回退到原始回答：');
            process.stdout.write(finalContent + '\n');
          }
          const phase2Ms = Date.now() - phase2Start;
          console.log(`\n⏱ Phase1: ${(phase1Ms / 1000).toFixed(1)}s | Phase2: ${(phase2Ms / 1000).toFixed(1)}s (KV Cache 复用前缀)`);
        } else {
          // 常规输出：内容少时不拆两阶段
          console.log(`\n✅ 分析完成 (总耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s)：\n`);
          process.stdout.write(finalContent + '\n');
        }

        taskComplete = true;
        break;
      }

      if (response.tool_calls && response.tool_calls.length > 0) {
        extractStepTitle(response.content ?? '', response.tool_calls, stepIndex);

        const assistantMsg: ChatMessage = {
          role: 'assistant', content: response.content ?? '', tool_calls: response.tool_calls,
        };
        messages.push(assistantMsg);

        const deniedResults: Array<{ tc: import('deepseek-code-shared').ToolCall; result: import('deepseek-code-shared').ToolExecutionResult }> = [];
        const toolCallsToExecute = [...response.tool_calls];

        if (permissionManager) {
          const writeTools = new Set(WRITE_TOOLS.map((t: { name: string }) => t.name));
          for (let i = toolCallsToExecute.length - 1; i >= 0; i--) {
            const tc = toolCallsToExecute[i];
            const isWrite = writeTools.has(tc.function.name);
            if (isWrite) {
              const risk = tc.function.name === 'run_command' ? 'needs_confirm' as const : 'dangerous' as const;
              const decision = await permissionManager.requestPermission({
                type: tc.function.name === 'apply_patch' ? 'apply_patch' : tc.function.name === 'run_command' ? 'run_command' : 'write_file',
                target: tc.function.name, risk,
                reason: `Agent 请求执行: ${tc.function.name}`,
              });
              if (decision === 'deny') {
                toolCallsToExecute.splice(i, 1);
                deniedResults.push({ tc, result: { success: false, content: '用户拒绝了此操作', error: 'denied' } });
              }
            }
            if (tc.function.name === 'run_command' && !readOnly) {
              try {
                const args = JSON.parse(tc.function.arguments);
                const cmdRisk = permissionManager.assessCommandRisk((args.command as string) ?? '');
                if (cmdRisk === 'forbidden') {
                  toolCallsToExecute.splice(i, 1);
                  deniedResults.push({ tc, result: { success: false, content: '该命令被安全策略禁止', error: 'forbidden' } });
                }
              } catch { /* ignore */ }
            }
          }
        }

        const toolResults: ToolExecutionResult[] = [];
        const execStart = Date.now();

        toolCallCount += toolCallsToExecute.length;
        for (const tc of toolCallsToExecute) toolSequence.push(tc.function.name);
        if (toolCallsToExecute.length > 1) {
          console.log(`⚡ 并行执行 ${toolCallsToExecute.length} 个工具...`);
          const allResults = await Promise.all(toolCallsToExecute.map(async (tc) => {
            const fn = tc.function;
            const parsed = parseToolArgs(fn);
            const result = parsed.ok
              ? await executeTool(fn.name, parsed.args, tools, toolCtx)
              : { success: false, content: '', error: `工具参数 JSON 解析失败: ${parsed.error}` };
            return { tc, result, target: formatToolTarget(fn.name, parsed.ok ? parsed.args : {}) };
          }));
          for (const { tc, result, target } of allResults) {
            toolResults.push(result);
            const errInfo = !result.success && result.error && result.error !== 'undefined' ? ` → ${result.error}` : '';
            console.log(`  ${result.success ? '✅' : '❌'} ${tc.function.name} ${target} (${result.content.length} 字符)${errInfo}`);
          }
          console.log(`  ⏱ 耗时: ${Date.now() - execStart}ms`);
        } else if (toolCallsToExecute.length === 1) {
          const tc = toolCallsToExecute[0];
          const fn = tc.function;
          const parsed = parseToolArgs(fn);
          const result = parsed.ok
            ? await executeTool(fn.name, parsed.args, tools, toolCtx)
            : { success: false, content: '', error: `工具参数 JSON 解析失败: ${parsed.error}` };
          const args = parsed.ok ? parsed.args : {};
          toolResults.push(result);
          console.log(`  ${result.success ? '✅' : '❌'} ${fn.name} ${formatToolTarget(fn.name, args)} (${result.content.length} 字符)${!result.success ? ` → ${result.error}` : ''}`);
        }

        const step = createStep(stepIndex, 'tool_call', `${toolCallsToExecute.length} 个工具调用`);
        step.toolCalls = toolCallsToExecute;
        step.toolResults = toolResults;
        session.steps.push(step);

        // 同步已读文件到 session.knownFiles（报告校验用）
        for (let i = 0; i < toolCallsToExecute.length; i++) {
          const tc = toolCallsToExecute[i];
          const result = toolResults[i];
          if (!result?.success) continue;
          const files = extractReadTargets(tc);
          for (const f of files) {
            const normalized = f.replace(/\\/g, '/');
            if (!session.knownFiles.some(k => k.replace(/\\/g, '/') === normalized)) {
              session.knownFiles.push(f);
            }
          }
        }

        // No-progress 检测：仅当连续多轮"只读同样的文件"时才触发
        // 如果 Agent 换了策略（执行命令、搜索新关键词、列出新目录），说明在积极探索，不算停滞
        const currentFiles = new Set<string>(
          toolCallsToExecute.filter((tc) => tc.function.name === 'read_file')
            .map((tc) => { try { return (JSON.parse(tc.function.arguments) as { filePath: string }).filePath; } catch { return ''; } })
            .filter(Boolean),
        );
        const hasNewFile = [...currentFiles].some((f) => !lastReadFiles.has(f));
        const hasOtherTools = toolCallsToExecute.some((tc) =>
          !['read_file', 'read_file_range', 'read_file_batch'].includes(tc.function.name)
        );
        // 只读文件无新增 + 没有尝试其他工具 → 可能是停滞
        if (!hasNewFile && !hasOtherTools && toolCallsToExecute.length > 0) {
          noProgressRounds++;
          if (noProgressRounds >= 5) {
            console.log('⚠️ 连续 5 轮仅读同样文件，停止探索');
            const readSoFar = [...lastReadFiles].slice(0, 20).join(', ');
            const fallback = `已读取 ${lastReadFiles.size} 个文件，但模型未能给出最终分析。\n已读取的文件: ${readSoFar}${lastReadFiles.size > 20 ? ' ...' : ''}\n\n建议: 尝试用更具体的任务描述重试，或指定具体文件。`;
            session.steps.push(createStep(stepIndex, 'final', fallback));
            messages.push({ role: 'assistant', content: fallback });
            console.log(`\n📋 兜底输出:\n${fallback}`);
            taskComplete = true;
            session.stopReason = 'no_progress';
            break;
          }
        } else {
          noProgressRounds = 0;  // 有新文件或换了策略 → 重置
        }
        for (const f of currentFiles) lastReadFiles.add(f);

        for (let i = 0; i < toolCallsToExecute.length; i++) {
          const tc = toolCallsToExecute[i];
          const result = toolResults[i];
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result.success ? result.content : `工具执行失败: ${result.error ?? '未知错误'}` });
        }
        for (const { tc, result } of deniedResults) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content });
        }

        // 审计任务软约束: 首轮禁止全仓 glob/list_files
        if (stepIndex === 1 && (session as any).__contextPolicy === 'full_agent' && isAudit) {
          const usedGlob = toolCallsToExecute.some(tc => /^(glob|list_files)$/i.test(tc.function.name));
          if (usedGlob) {
            messages.push({
              role: 'user',
              content: '请优先基于 seed context (package.json/rules/git diff) 使用 search_code 按关键词定位目标文件，不要先全仓列目录。如果已定位到文件，直接 read_file。',
            });
            console.log('  🎯 审计纠偏: glob→search_code');
          }
        }

        // 修复任务软约束: 首轮禁止整文件读/全仓扫
        const isRepair = (session as any).__auditSeedToolSequence?.length > 0
          && /报错|异常|失败|TS\d+|TypeError|ReferenceError|SyntaxError|解析失败/i.test(session.taskDescription);
        if (stepIndex === 1 && isRepair) {
          const usedFullRead = toolCallsToExecute.some(tc => tc.function.name === 'read_file');
          const usedScan = toolCallsToExecute.some(tc => /^(glob|list_files)$/i.test(tc.function.name));
          if (usedFullRead || usedScan) {
            messages.push({
              role: 'user',
              content: 'Seed context 已提供精确的 file:line 和 git_diff。请不要整文件读取(read_file)或全仓扫描(list_files/glob)。如需补充，只用 read_file_range 精读或 search_code 搜索。直接基于 seed 分析输出。',
            });
            console.log('  🔧 修复纠偏: read_file→read_file_range');
          }
        }
      } else {
        const thinking = (response.content ?? '') || '(模型思考中...)';
        session.steps.push(createStep(stepIndex, 'thinking', thinking.slice(0, 500)));
        messages.push({ role: 'assistant', content: thinking });
        console.log(`💭 ${thinking.length > 200 ? thinking.slice(0, 200) + '...' : thinking}`);
      }
    }

    // 0工具调用+0执行步骤 → 实际未执行, 必须先判定再持久化
    if (toolCallCount === 0 && session.steps.filter(s => s.type !== 'planning').length === 0) {
      console.log(`⚠️ 任务未实际执行 (0工具调用, 0执行步骤)`);
      taskComplete = false;
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    let summary = taskComplete
      ? `任务分析完成 (${totalTime}s, ${stepIndex} 步)`
      : `任务未能执行。可能原因: 路由错误或工具不可用。建议重试或简化任务。`;

    // 修复完成度复核: 结构化结果直接写入, 不靠模型输出
    const fvResult = session.__fvResult as import('../tools/fix-verification.js').FixVerificationResult | undefined;
    const { GAP_LABELS: GL } = await import('../tools/fix-verification.js');
    if (fvResult) {
      const lines = ['## 修复完成度复核\n'];
      const trend = session.__fvTrend;
      if (trend && trend.length > 0) lines.push(...trend);
      lines.push('*信号: diff=diff命中 log=提交命中 test=关联测试变更*\n');

      const strongFixes = fvResult.fixed.filter(f => f.evidenceLevel === 'strong');
      const mediumFixes = fvResult.fixed.filter(f => f.evidenceLevel === 'medium');
      if (strongFixes.length > 0) lines.push(`\n✅ 已确认修复 (${strongFixes.length}):\n${strongFixes.map(f => `  - ${f.title} [${signalsLabel(f.fixSignals)}]\n    证据: ${f.evidence.join('; ')}`).join('\n')}`);
      if (mediumFixes.length > 0) lines.push(`\n🟡 基本修复 (${mediumFixes.length}):\n${mediumFixes.map(f => `  - ${f.title} [${signalsLabel(f.fixSignals)}]\n    证据: ${f.evidence.join('; ')}\n    缺口: ${GL[f.gapReason || ''] || '未知'}`).join('\n')}`);
      if (fvResult.partial.length > 0) lines.push(`\n⚠️ 部分修复 (${fvResult.partial.length}):\n${fvResult.partial.map(f => `  - ${f.title} [${signalsLabel(f.fixSignals)}]\n    ${f.reason}\n    缺口: ${GL[f.gapReason || ''] || '未知'}`).join('\n')}`);
      if (fvResult.unresolved.length > 0) lines.push(`\n❌ 仍未修复 (${fvResult.unresolved.length}):\n${fvResult.unresolved.map(f => `  - ${f.title} [${f.evidenceLevel}]`).join('\n')}`);
      if (fvResult.unknown.length > 0) lines.push(`\n❓ 无法确认 (${fvResult.unknown.length}):\n${fvResult.unknown.map(f => `  - ${f.title}\n    ${f.reason}`).join('\n')}`);
      summary = lines.join('\n');
      console.log(`\n📊 修复复核: ✅${strongFixes.length}+🟡${mediumFixes.length} ⚠️${fvResult.partial.length} ❌${fvResult.unresolved.length} ❓${fvResult.unknown.length}`);
    }

    session.completed = taskComplete;
    session.summary = summary;
    await memory.saveSession(session);

    const cacheRate = totalPrompt > 0 ? ((totalCache / totalPrompt) * 100).toFixed(0) : '0';
    const cost = estimateCost(totalPrompt, totalCache, totalCompletion, flashCalls, proCalls);
    session.stats = {
      totalPromptTokens: totalPrompt,
      totalCompletionTokens: totalCompletion,
      cacheHitTokens: totalCache,
      cacheMissTokens: totalCacheMiss,
      flashCalls,
      proCalls,
      toolCalls: toolCallCount,
      elapsedMs: Date.now() - startTime,
      estimatedCostUsd: cost,
      prefixHashes: (session as any).__prefixHashes ? {
        global: (session as any).__prefixHashes.globalPrefixHash,
        runtime: (session as any).__prefixHashes.runtimePrefixHash,
        project: (session as any).__prefixHashes.projectPrefixHash,
        session: (session as any).__prefixHashes.sessionPrefixHash,
      } : undefined,
      modelCalls,
      toolSequence,
      auditSeedSequence,
    };

    console.log(`\n📊 KV Cache: ${cacheRate}% 命中 (${totalCache}/${totalPrompt} prompt tokens) | 总输出: ${totalCompletion} tokens`);
    console.log(`💰 预估成本: $${cost.toFixed(4)} | Flash×${flashCalls} Pro×${proCalls} | 工具×${toolCallCount}`);
    console.log(`📝 会话已保存: ${session.id}  ⏱ ${totalTime}s`);

    await memory.saveSession(session);
    return { session, success: taskComplete, summary };
  } catch (e) {
    const errorMsg = String(e);
    console.error(`❌ Agent 执行异常: ${errorMsg}`);
    session.summary = `异常终止: ${errorMsg}`;
    session.phase = 'failed';
    session.interruptionReason = errorMsg.slice(0, 200);
    await memory.saveSession(session);
    return { session, success: false, summary: `异常终止: ${errorMsg}`, error: errorMsg };
  }
}

// ============================================================
// 辅助函数
// ============================================================

/** 生成计划（流式输出步骤描述） */
async function buildAuditSeedContext(tools: ToolExecutors, workingDir: string): Promise<{ context: string; sequence: string[] }> {
  const seedCalls: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'read_package_json', args: {} },
    { name: 'read_project_rules', args: {} },
    { name: 'git_status', args: {} },
    { name: 'git_diff', args: {} },
  ];

  const parts: string[] = ['## Audit Seed Context'];
  const sequence: string[] = [];
  for (const call of seedCalls) {
    const result = await executeTool(call.name, call.args, tools, { workingDir, mode: 'readonly' });
    sequence.push(call.name);
    const status = result.success ? 'ok' : 'failed';
    const body = result.success ? result.content : (result.error ?? result.content);
    parts.push(`### ${call.name} (${status})\n${String(body).slice(0, 4000)}`);
  }

  parts.push(
    '',
    'Audit path rule: prefer targeted read/search based on this seed context. Avoid random whole-repo list/glob scans unless the task explicitly needs them.',
  );
  return { context: parts.join('\n'), sequence };
}

/** Repair seed: 错误定位 → 最小上下文 → git diff */
async function buildRepairSeedContext(task: string, tools: ToolExecutors, workingDir: string): Promise<{ context: string; sequence: string[] }> {
  const sequence: string[] = [];
  const parts: string[] = ['## Repair Seed Context'];

  // 多模式文件路径提取 (优先级: stack trace > file:line > 第N行 > 测试文件)
  const filePatterns = [
    /\(([a-zA-Z0-9_/.-]+\.(?:ts|tsx|js|jsx|json|yml|yaml)):(\d+)(?::\d+)?\)/,  // stack trace: at fn (file:line:col)
    /([a-zA-Z0-9_/.-]+\.(?:ts|tsx|js|jsx|json|yml|yaml))\s*[:(：]\s*(\d+)/,       // file:line or file(123)
    /([a-zA-Z0-9_/.-]+\.(?:ts|tsx|js|jsx|json|yml|yaml))\s*第\s*(\d+)\s*行/,       // 中文行号: file 第123行
    /(?:在|at)\s+([a-zA-Z0-9_/.-]+\.(?:ts|tsx|js|jsx|json|yml|yaml))\s*第\s*(\d+)\s*行/i, // 在 file 第N行
  ];
  let fileMatch: RegExpMatchArray | null = null;
  for (const p of filePatterns) {
    fileMatch = task.match(p);
    if (fileMatch) break;
  }

  // 符号/测试名提取
  const symbolMatch = task.match(/(?:符号|symbol|函数|function|class|export|is not defined|not found)\s+['"]?(\w+)['"]?/i);
  const testMatch = task.match(/([a-zA-Z0-9_/.-]+\.test\.(?:ts|tsx|js))\b/i);
  const hasAnchor = fileMatch || symbolMatch || testMatch;

  // 1. git_diff
  const diffResult = await executeTool('git_diff', {}, tools, { workingDir, mode: 'readonly' });
  sequence.push('git_diff');
  parts.push(`### git_diff\n${String(diffResult.content).slice(0, 3000)}`);

  // 2. 精确定位: read_file_range
  if (fileMatch) {
    const file = fileMatch[1]; const line = parseInt(fileMatch[2]);
    const rangeResult = await executeTool('read_file_range', { filePath: file, startLine: Math.max(1, line - 10), endLine: line + 20 }, tools, { workingDir, mode: 'readonly' });
    sequence.push('read_file_range');
    parts.push(`### read_file_range ${file} L${Math.max(1, line - 10)}-${line + 20}\n${String(rangeResult.content).slice(0, 4000)}`);
  }

  // 3. 符号/测试搜索 (只在无精确路径时)
  const searchTarget = testMatch?.[1] ?? (symbolMatch && !fileMatch ? symbolMatch[1] : null);
  if (searchTarget) {
    const searchResult = await executeTool('search_code', { pattern: searchTarget, path: 'packages/' }, tools, { workingDir, mode: 'readonly' });
    sequence.push('search_code');
    parts.push(`### search_code "${searchTarget}"\n${String(searchResult.content).slice(0, 3000)}`);
  }

  // 4. 无锚点 → 要求追问
  if (!hasAnchor) {
    parts.push('### ⚠️ 无锚点', '输入中未提取到文件路径、行号、符号名或测试文件名。请追问具体错误信息，不要全仓扫描。');
  }

  parts.push('', 'Repair rule: read_file_range→search_code→git_diff→readOnly=suggestion');
  return { context: parts.join('\n'), sequence };
}

async function generatePlanWithStreaming(
  model: ModelClient,
  repoInfo: import('deepseek-code-shared').RepoInfo,
  taskDescription: string,
  repoSummary: string,
  stream: boolean,
  mode?: string,
): Promise<{ plan: ExecutionPlan; shownCount: number }> {
  if (stream) {
    try {
      let full = '';
      let shownSteps = 0;
      const gen = model.chatStream(
        [
          { role: 'system', content: `你是 DeepSeek Code Agent。生成 JSON 执行计划。

输出格式（严格）:
{"steps":[{"order":1,"action":"read","description":"读取根package.json了解项目配置","targetFiles":["package.json"]},{"order":2,"action":"search","description":"搜索安全问题","targetFiles":["packages/"]}]}

可用 action: read(读文件) / search(搜索/列目录) / verify(验证发现)
可用工具名: read_file, read_file_batch, search_code, list_files, glob, git_status, git_diff, read_package_json, find_references

铁律: ①只输出上述JSON格式 ②禁止输出分析结论 ③targetFiles写真实路径 ④步骤数3-8 ⑤action只用read/search/verify` },
          { role: 'user', content: `项目:\n${repoSummary}\n\n需求: ${taskDescription}\n\nJSON:` },
        ],
        { temperature: 0.1, maxTokens: 512, disableThinking: true },
      );

      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let i = 0;
      let startedShowing = false;
      const start = Date.now();

      const timer = setInterval(() => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        if (!startedShowing) {
          process.stdout.write(`\r  ${frames[i++ % frames.length]} 分析需求并生成计划... (${elapsed}s)`);
        }
      }, 200);

      try {
        for await (const chunk of gen) {
          full += chunk;
          const descs = [...full.matchAll(/"description"\s*:\s*"([^"]+)"/g)];
          while (shownSteps < descs.length) {
            if (!startedShowing) {
              clearInterval(timer);
              process.stdout.write('\r' + ' '.repeat(60) + '\r');
              startedShowing = true;
            }
            process.stdout.write(`  ${shownSteps + 1}. ${descs[shownSteps][1]}\n`);
            shownSteps++;
          }
        }
      } finally {
        clearInterval(timer);
        if (!startedShowing) {
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
        }
      }

      if (full) {
        const plan = parsePlanJson(full, taskDescription, repoInfo);
        return { plan, shownCount: shownSteps };
      }
    } catch {
      // 流式失败降级
    }
  }
  const plan = await generatePlan(model, repoInfo, taskDescription, repoSummary, mode);
  return { plan, shownCount: 0 };
}

/** 显示旋转动画，等待 Promise 完成后清除 */
async function withSpinner<T>(promise: Promise<T>, label: string): Promise<T> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const start = Date.now();

  const timer = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`\r  ${frames[i++ % frames.length]} ${label} (${elapsed}s)`);
  }, 200);

  try {
    return await promise;
  } finally {
    clearInterval(timer);
    // 清除 spinner 行，不换行（让后续输出自然接上）
    process.stdout.write('\r' + ' '.repeat(50) + '\r');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从模型思考文本中提取步骤标题并输出 */
function extractStepTitle(thinking: string, toolCalls: ToolCall[], _stepNum: number): void {
  // 取思考文本的第一句（到第一个句号或换行）作为标题
  const firstSentence = thinking.split(/[。\n]/)[0]?.trim();
  if (firstSentence && firstSentence.length > 4 && firstSentence.length < 80) {
    console.log(`\n> ${firstSentence}`);
    return;
  }

  // 降级：用工具名拼标题
  const toolNames = [...new Set(toolCalls.map((tc) => tc.function.name))];
  const label = toolNames.map((n) => {
    switch (n) {
      case 'read_file': return '读取文件';
      case 'search_code': return '搜索代码';
      case 'list_files': return '列出目录';
      case 'run_command': return '执行命令';
      case 'apply_patch': return '应用补丁';
      case 'write_file': return '写入文件';
      case 'git_diff': return '查看差异';
      case 'git_status': return 'Git 状态';
      default: return n;
    }
  }).join(' + ');

  console.log(`\n> ${label}`);
}

/** 从工具参数中提取可读的目标路径 */
function formatToolTarget(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file':
    case 'read_file_range': {
      const path = args.filePath ? `"${args.filePath}"` : '';
      const start = args.startLine ? `L${args.startLine}` : '';
      const end = args.endLine ? `-L${args.endLine}` : '';
      const range = start || end ? ` [${start}${end}]` : '';
      return path + range;
    }
    case 'write_file':
      return args.filePath ? `"${args.filePath}"` : '';
    case 'search_code':
      return args.pattern ? `"${args.pattern}"` : '';
    case 'list_files':
    case 'glob':
      return args.directory ? `"${args.directory}"` : '';
    case 'apply_patch': {
      const files = args.filesAffected as string[] | undefined;
      return files?.length ? files.map((f) => `"${f}"`).join(', ') : '';
    }
    case 'run_command':
      return args.command ? `\`${(args.command as string).slice(0, 60)}\`` : '';
    case 'git_diff':
      return args.file ? `"${args.file}"` : '工作区';
    case 'git_status':
      return '';
    default:
      return '';
  }
}

function logPrefixHashes(h: PromptHashes): void {
  console.log(`🔑 prefix: G=${h.globalPrefixHash} R=${h.runtimePrefixHash} P=${h.projectPrefixHash} S=${h.sessionPrefixHash} D=${h.dynamicTailHash}`);
}


function formatPlan(plan: ExecutionPlan): string {
  const lines: string[] = [
    `📋 复杂度: ${plan.complexity}  |  模型: ${plan.recommendedModel}`,
    '',
  ];

  for (const s of plan.steps) {
    const title = s.description || '(无描述)';
    lines.push(`  ${s.order}. ${title}`);
    if (s.targetFiles?.length) {
      lines.push(`     📁 ${s.targetFiles.slice(0, 3).join(', ')}${s.targetFiles.length > 3 ? ' ...' : ''}`);
    }
  }

  if (plan.risks.length > 0) {
    lines.push('', '⚠️ 风险: ' + plan.risks.join('; '));
  }

  return lines.join('\n');
}

// ═══ Cost Estimator ═══

// DeepSeek V4 定价 (per 1M tokens, USD)
const PRICING = {
  pro: { inputCacheMiss: 0.55, inputCacheHit: 0.14, output: 2.19 },
  flash: { inputCacheMiss: 0.14, inputCacheHit: 0.04, output: 0.55 },
};

function signalsLabel(s: { diff: boolean; log: boolean; test: boolean }): string {
  const parts = [];
  if (s.diff) parts.push('diff');
  if (s.log) parts.push('log');
  if (s.test) parts.push('test');
  return parts.length > 0 ? parts.join('+') : '无信号';
}

/** 单次模型调用成本（per-call 精确计算） */
function calcCallCost(model: string, usage: { prompt_tokens: number; completion_tokens: number; cache_hit_tokens?: number; cache_miss_tokens?: number }): number {
  const tier = model.includes('flash') ? PRICING.flash : PRICING.pro;
  const hitTokens = usage.cache_hit_tokens ?? 0;
  const missTokens = (usage.cache_miss_tokens ?? (usage.prompt_tokens - hitTokens));
  return (missTokens / 1_000_000) * tier.inputCacheMiss
    + (hitTokens / 1_000_000) * tier.inputCacheHit
    + (usage.completion_tokens / 1_000_000) * tier.output;
}

function estimateCost(
  totalPrompt: number, totalCache: number, totalCompletion: number,
  flashCalls: number, proCalls: number,
): number {
  // 简化估算: 按 Pro/Flash 调用比例分摊
  const totalCalls = flashCalls + proCalls || 1;
  const proRatio = proCalls / totalCalls;
  const flashRatio = flashCalls / totalCalls;

  const cacheMiss = totalPrompt - totalCache;

  // Pro 分摊
  const proCacheMiss = cacheMiss * proRatio;
  const proCacheHit = totalCache * proRatio;
  const proOutput = totalCompletion * proRatio;

  // Flash 分摊
  const flashCacheMiss = cacheMiss * flashRatio;
  const flashCacheHit = totalCache * flashRatio;
  const flashOutput = totalCompletion * flashRatio;

  const cost =
    (proCacheMiss / 1_000_000) * PRICING.pro.inputCacheMiss +
    (proCacheHit / 1_000_000) * PRICING.pro.inputCacheHit +
    (proOutput / 1_000_000) * PRICING.pro.output +
    (flashCacheMiss / 1_000_000) * PRICING.flash.inputCacheMiss +
    (flashCacheHit / 1_000_000) * PRICING.flash.inputCacheHit +
    (flashOutput / 1_000_000) * PRICING.flash.output;

  return cost;
}

/** 安全解析工具参数——JSON损坏时返回错误而不执行 */
function parseToolArgs(fn: { name: string; arguments: string }): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  try {
    return { ok: true, args: JSON.parse(fn.arguments) };
  } catch {
    return { ok: false, error: `${fn.name} 参数 JSON 无效` };
  }
}

/** 从 ToolCall 提取读取的文件路径 */
function extractReadTargets(tc: import('deepseek-code-shared').ToolCall): string[] {
  const name = tc.function.name;
  const parsed = parseToolArgs(tc.function);
  if (!parsed.ok) return [];
  const args = parsed.args;
  switch (name) {
    case 'read_file':
    case 'read_file_range':
      return args.filePath ? [args.filePath as string] : [];
    case 'read_file_batch':
      if (Array.isArray(args.filePaths)) return args.filePaths as string[];
      if (Array.isArray(args.files)) return args.files as string[];
      return [];
    default:
      return [];
  }
}

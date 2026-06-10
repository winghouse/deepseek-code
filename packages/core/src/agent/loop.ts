// ============================================================
// Agent Runtime — 主循环
// ============================================================

import type { ChatMessage, Session, AgentStep, ToolCall, ExecutionPlan, ToolExecutionResult } from 'deepseek-code-shared';
import { canTransitionPhase, fileFingerprint } from 'deepseek-code-shared';
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

    const resumeModel = router.getClient(loaded.modelName as 'deepseek-v4-pro' | 'deepseek-v4-flash');
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
    // 4. 扫描项目
    const scanStart = Date.now();
    process.stdout.write('🔍 扫描项目... ');
    const repoInfo = await scanRepo({ workingDir });
    session.repoInfo = repoInfo;
    const repoSummary = buildRepoSummary(repoInfo);
    console.log(`✅ (${Date.now() - scanStart}ms) → ${repoInfo.techStack.language}${repoInfo.techStack.framework ? ' + ' + repoInfo.techStack.framework : ''}`);
    console.log('');

    // 5. 生成计划（支持流式输出）
    const planStart = Date.now();
    process.stdout.write('📋 生成计划... ');
    // 计划用 Flash（快），执行用 Pro（强）
    const planResult = await generatePlanWithStreaming(router.flash, repoInfo, taskDescription, repoSummary, streaming, readOnly ? 'readonly' : 'ask');
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
      userInput: taskDescription,
    });
    logPrefixHashes(promptResult.hashes);

    const messages: ChatMessage[] = [
      { role: 'system', content: promptResult.layers.globalPrefix + '\n\n' + promptResult.layers.runtimePrefix + '\n\n' + promptResult.layers.projectPrefix + '\n\n' + promptResult.layers.sessionPrefix + '\n\n' + promptResult.layers.dynamicTail },
    ];

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
  let totalPrompt = 0, totalCache = 0, totalCompletion = 0;

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

      // DeepSeek V4: 审查/审计任务提升推理深度
      const isAudit = /审查|审计|检查.*优化|代码质量|安全.*漏洞|架构.*问题/i.test(session.taskDescription);
      const response = await withSpinner(
        model.chat(messages, {
          tools: availableTools,
          temperature: 0.3,
          reasoningEffort: isAudit ? 'high' : undefined,
        }),
        '模型思考中',
      );

      totalPrompt += response.usage.prompt_tokens;
      totalCache += response.usage.cache_hit_tokens ?? 0;
      totalCompletion += response.usage.completion_tokens;
      const cacheInfo = response.usage.cache_hit_tokens
        ? ` | 缓存: ${((response.usage.cache_hit_tokens / response.usage.prompt_tokens) * 100).toFixed(0)}%`
        : '';
      console.log(`📊 ${response.usage.prompt_tokens}+${response.usage.completion_tokens} tokens${cacheInfo}`);

      if (response.finish_reason === 'stop' && !response.tool_calls) {
        const finalContent = response.content ?? '';
        session.steps.push(createStep(stepIndex, 'final', finalContent));
        messages.push({ role: 'assistant', content: finalContent });
        console.log(`\n✅ 分析完成 (总耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s)：\n`);
        if (streaming) {
          for (const char of finalContent) {
            process.stdout.write(char);
            if (char === '\n') await sleep(5);
          }
          process.stdout.write('\n');
        } else {
          console.log(finalContent);
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
            if (isWrite && readOnly) {
              toolCallsToExecute.splice(i, 1);
              deniedResults.push({ tc, result: { success: false, content: '只读模式下不允许写操作', error: 'readonly' } });
              continue;
            }
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

        if (toolCallsToExecute.length > 1) {
          console.log(`⚡ 并行执行 ${toolCallsToExecute.length} 个工具...`);
          const allResults = await Promise.all(toolCallsToExecute.map(async (tc) => {
            const fn = tc.function;
            let args: Record<string, unknown>;
            try { args = JSON.parse(fn.arguments); } catch { args = {}; }
            const result = await executeTool(fn.name, args, tools, toolCtx);
            return { tc, result, target: formatToolTarget(fn.name, args) };
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
          let args: Record<string, unknown>;
          try { args = JSON.parse(fn.arguments); } catch { args = {}; }
          const result = await executeTool(fn.name, args, tools, toolCtx);
          toolResults.push(result);
          console.log(`  ${result.success ? '✅' : '❌'} ${fn.name} ${formatToolTarget(fn.name, args)} (${result.content.length} 字符)${!result.success ? ` → ${result.error}` : ''}`);
        }

        const step = createStep(stepIndex, 'tool_call', `${toolCallsToExecute.length} 个工具调用`);
        step.toolCalls = toolCallsToExecute;
        step.toolResults = toolResults;
        session.steps.push(step);

        // No-progress: 当前轮读取文件 vs 上轮
        const currentFiles = new Set<string>(
          toolCallsToExecute.filter((tc) => tc.function.name === 'read_file')
            .map((tc) => { try { return (JSON.parse(tc.function.arguments) as { filePath: string }).filePath; } catch { return ''; } })
            .filter(Boolean),
        );
        const hasNew = [...currentFiles].some((f) => !lastReadFiles.has(f));
        if (!hasNew && toolCallsToExecute.length > 0) {
          noProgressRounds++;
          if (noProgressRounds >= 3) {
            console.log('⚠️ 连续 3 轮无新增文件，停止探索');
            taskComplete = true;
            session.stopReason = 'no_progress';
            break;
          }
        } else if (hasNew) {
          noProgressRounds = 0;
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
      } else {
        const thinking = (response.content ?? '') || '(模型思考中...)';
        session.steps.push(createStep(stepIndex, 'thinking', thinking.slice(0, 500)));
        messages.push({ role: 'assistant', content: thinking });
        console.log(`💭 ${thinking.length > 200 ? thinking.slice(0, 200) + '...' : thinking}`);
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const summary = taskComplete
      ? `任务分析完成 (${totalTime}s, ${stepIndex} 步)`
      : `达到最大步骤数 (${maxSteps})，任务可能未完全完成 (${totalTime}s)`;

    session.completed = taskComplete;
    session.summary = summary;
    await memory.saveSession(session);

    const cacheRate = totalPrompt > 0 ? ((totalCache / totalPrompt) * 100).toFixed(0) : '0';
    console.log(`\n📊 KV Cache: ${cacheRate}% 命中 (${totalCache}/${totalPrompt} prompt tokens) | 总输出: ${totalCompletion} tokens`);
    console.log(`📝 会话已保存: ${session.id}  ⏱ ${totalTime}s`);

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
          { role: 'system', content: `你是 DeepSeek Code Agent。根据项目信息生成 JSON 执行计划。只输出 JSON。` },
          { role: 'user', content: `项目:\n${repoSummary}\n\n需求: ${taskDescription}\n\nJSON:` },
        ],
        { temperature: 0.1, maxTokens: 2048 },
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
    process.stdout.write('\r' + ' '.repeat(60) + '\n');
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

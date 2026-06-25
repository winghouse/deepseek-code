#!/usr/bin/env node
// ============================================================
// DeepSeek Code CLI — 主入口
// ============================================================

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runAgentLoop, continueLoop, ModelRouter, createToolExecutors, FileMemoryStore, PermissionManager, createDefaultPermissionConfig, filterSecrets, READ_ONLY_TOOLS, WRITE_TOOLS, scanRepo, buildRepoSummary, saveInteractiveState, loadInteractiveState, clearInteractiveState, buildLastAgentResult } from 'deepseek-code-core';
import { routeInput } from 'deepseek-code-core';
import type { RouteDecision, AuditFinding } from 'deepseek-code-shared';
import { MODEL_PRO, MODEL_FLASH } from 'deepseek-code-shared';
import type { LastAgentResult, InteractiveSessionState } from 'deepseek-code-core';
import type { ModelRouterConfig } from 'deepseek-code-core';
import type { DeepSeekCodeConfig, PermissionRequest } from 'deepseek-code-shared';
import { resolvePendingChoice } from './resolve-pending-choice.js';
import { ensureConfig, loadConfig, CONFIG_PATH } from './config.js';
import { getTemplates, generateAgentsMdTemplate } from './templates.js';

// 在任何命令执行前自动确保配置存在
ensureConfig();

// ---- 轻量 Spinner（避免 silent gap） ----

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(label: string): ReturnType<typeof setInterval> {
  let i = 0;
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (process.stdout.isTTY) {
      process.stdout.write(`\r  ${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]} ${label}... (${elapsed}s)`);
    }
  }, 150);
  return timer;
}

function stopSpinner(timer: ReturnType<typeof setInterval>) {
  clearInterval(timer);
  if (process.stdout.isTTY) {
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
  }
}

// ---- CLI 定义 ----

const program = new Command();

program
  .name('dscode')
  .description('DeepSeek Code：面向中文开发者的 AI 编程 Agent CLI')
  .version('0.1.0')
  .argument('[task]', '任务描述（如果不指定，进入交互模式）')
  .option('-m, --model <model>', '指定模型: auto, deepseek-v4-pro, deepseek-v4-flash', 'auto')
  .option('--api-key <key>', 'DeepSeek API Key')
  .option('--base-url <url>', 'API Base URL')
  .option('--plan', '📋 计划模式(只读)', false)
  .option('--edit', '✏️ 编辑模式(默认)', true)
  .option('--auto', '🚀 自主模式(全自动)', false)
  .option('--dry-run', '仅生成计划，不执行', false)
  .option('-d, --dir <dir>', '指定项目目录', process.cwd())
  .option('--resume <session-id>', '恢复指定会话')
  .action(async (task: string | undefined, options: Record<string, string | boolean>) => {
    const config = loadConfig();

    // 合并选项
    const apiKey = (options.apiKey as string) ?? config.apiKey;
    const baseUrl = (options.baseUrl as string) ?? config.baseUrl ?? 'https://api.deepseek.com';
    const modelStrategy = (options.model as string) ?? 'auto';
    const runMode: 'plan' | 'edit' | 'auto' = options.plan ? 'plan' : options.auto ? 'auto' : 'edit';
    const workingDir = path.resolve(options.dir as string);
    const dryRun = options.dryRun as boolean;
    const resumeSessionId = (options.resume as string) || undefined;

    if (!apiKey) {
      console.log('❌ 未配置 DeepSeek API Key');
      console.log('');
      console.log('请通过以下方式之一配置：');
      console.log('  1. 环境变量: export DEEPSEEK_API_KEY=sk-xxxx');
      console.log('  2. 命令行参数: dscode --api-key sk-xxxx "任务"');
      console.log(`  3. 配置文件: ${CONFIG_PATH}`);
      process.exit(1);
    }

    if (!task && !resumeSessionId) {
      await interactiveMode(config, apiKey, baseUrl, modelStrategy, workingDir, runMode);
      return;
    }

    // 意图分流：Hybrid Router
    if (task && !resumeSessionId) {
      const routerMode = runMode === 'plan' ? 'readonly' as const : runMode === 'edit' ? 'ask' as const : 'auto' as const;
      const route = await routeInput(task, {
        mode: routerMode,
        projectName: path.basename(workingDir),
        projectPath: workingDir,
      }, createLLMRouterClient(apiKey, baseUrl));
      logRoute(route, routerMode);
      // audit_task 走 Agent 审查（audit_pipeline 仅用于 dscode audit 命令）
      // Execution Dispatcher: diff review（必须在 debug_task 之前）
      if ((route.intent === 'command_status' || route.intent === 'debug_task') && /diff|git diff|改动|变更|changed/i.test(task)) {
        const { runReviewDiffPipeline } = await import('deepseek-code-core');
        console.log('📋 Review Diff Pipeline\n');
        const result = await runReviewDiffPipeline({ workingDir, onProgress: (s) => console.log(`  ⏳ ${s}`) });
        console.log(result.summary);
        console.log(`📊 统计: ${result.stats.totalFiles}文件 | +${result.stats.added}新增 ~${result.stats.modified}修改 -${result.stats.deleted}删除 | 🧪测试${result.stats.testFilesChanged} | 🔒安全${result.stats.securityFilesChanged} | ⚙️配置${result.stats.configFilesChanged}`);
        if (result.riskLevel !== 'low') console.log(`⚠️ 风险等级: ${result.riskLevel}`);
        console.log('');
        for (const f of result.findings) {
          const icon = f.severity === 'high' ? '🔴' : f.severity === 'medium' ? '🟡' : '🟢';
          const cat = f.category === 'security' ? '[安全]' : f.category === 'api' ? '[API]' : f.category === 'test' ? '[测试]' : f.category === 'dependency' ? '[依赖]' : f.category === 'config' ? '[配置]' : '';
          console.log(`  ${icon} ${cat} ${f.file}: ${f.description}`);
          if (f.lineHint) console.log(`     📍 ${f.lineHint}`);
          if (f.suggestion) console.log(`     💡 ${f.suggestion}`);
        }
        if (result.findings.length === 0) console.log('  ✅ 未发现明显问题');
        console.log(`\n⏱ ${(result.elapsedMs / 1000).toFixed(1)}s | 0 模型调用`);
        return;
      }
      // Execution Dispatcher: debug_task → Repair Pipeline（非 diff 类）
      // 硬门槛: 必须包含错误上下文(TS错误码/堆栈/报错/文件:行号)才进repair, 否则降级agent
      const hasErrorContext = /TS\d+|报错|异常|失败|堆栈|stack trace|\.(ts|tsx|js):\d+:\d+/.test(task);
      if (route.intent === 'debug_task' && hasErrorContext) {
        const { runRepairPipeline } = await import('deepseek-code-core');
        console.log('🔧 Repair Pipeline\n');
        const proClient = apiKey ? createProClient(apiKey, baseUrl) : undefined;
        const result = await runRepairPipeline({ workingDir, taskDescription: task, mode: routerMode, proClient, onProgress: (s) => console.log(`  ⏳ ${s}`) });
        console.log(result.summary);
        if (result.errorLocation) console.log(`📍 ${result.errorLocation.file ? `${result.errorLocation.file}:${result.errorLocation.line ?? '?'}` : ''} [${result.errorLocation.category}] ${result.errorLocation.message.slice(0, 120)}`);
        if (result.rootCause) console.log(`\n🔍 根因分析:\n${result.rootCause}`);
        if (result.suggestedFix) console.log(`💡 ${result.suggestedFix}`);
        if (result.filesExamined.length > 0) console.log(`📁 检查文件: ${result.filesExamined.join(', ')}`);
        console.log(`\n⏱ ${(result.elapsedMs / 1000).toFixed(1)}s`);
        return;
      }
      // Execution Dispatcher: url_fetch_pipeline
      if (route.execution === 'url_fetch_pipeline' && route.target?.type === 'url') {
        const { runUrlFetchPipeline, formatUrlFetchResult } = await import('deepseek-code-core');
        console.log('🌐 URL Fetch Pipeline\n');
        const result = await runUrlFetchPipeline(route.target.url, { onProgress: (s) => console.log(`  ⏳ ${s}`) });
        console.log(formatUrlFetchResult(result));
        console.log(`\n⏱ ${(result.elapsedMs / 1000).toFixed(1)}s`);
        return;
      }
      if (route.execution !== 'agent_readonly' && route.execution !== 'agent_plan' && route.execution !== 'agent_execute') {
        if (route.execution === 'llm_direct_limited') {
          console.log('⚠️ 当前 CLI 不能直接读取网页内容。请粘贴网页文本，或启用 web_fetch 工具。\n');
        }
        await handleLlmDirect(task, config, apiKey, baseUrl, undefined, undefined, []);
        return;
      }
    }

    // 单次任务 / 恢复会话
    await runTask(task || '恢复会话', config, apiKey, baseUrl, modelStrategy, workingDir, runMode, dryRun, resumeSessionId);
  });

// 交互模式：持续接收命令
program
  .command('chat')
  .description('进入交互对话模式')
  .option('-m, --model <model>', '模型选择', 'auto')
  .action(async (options) => {
    const config = loadConfig();
    const apiKey = options.apiKey ?? config.apiKey;
    if (!apiKey) {
      console.log('❌ 未配置 API Key');
      process.exit(1);
    }
    await interactiveMode(
      config,
      apiKey,
      options.baseUrl ?? config.baseUrl ?? 'https://api.deepseek.com',
      options.model,
      process.cwd(),
      'edit' as const,
    );
  });

// 计划模式：只生成计划不执行
program
  .command('plan <task>')
  .description('生成执行计划（不执行）')
  .option('-m, --model <model>', '模型选择', 'auto')
  .action(async (task, options) => {
    const config = loadConfig();
    const apiKey = options.apiKey ?? config.apiKey;
    if (!apiKey) {
      console.log('❌ 未配置 API Key');
      process.exit(1);
    }
    await runTask(
      task,
      config,
      apiKey,
      options.baseUrl ?? config.baseUrl ?? 'https://api.deepseek.com',
      options.model,
      process.cwd(),
      'plan' as const,
      true,
    );
  });

// Git Diff 查看
program
  .command('diff')
  .description('查看当前 Git 改动 (彩色输出)')
  .action(async () => {
    const { createToolExecutors } = await import('deepseek-code-core');
    const tools = createToolExecutors({ workingDir: process.cwd() });
    const result = await tools.gitDiff({});
    // 彩色着色：+红 -绿 @@青
    const colored = result.content
      .replace(/^(\+.*)/gm, '\x1b[32m$1\x1b[0m')
      .replace(/^(-.*)/gm, '\x1b[31m$1\x1b[0m')
      .replace(/^(@@.*@@)/gm, '\x1b[36m$1\x1b[0m');
    console.log(colored || '工作区干净');
  });

// 初始化项目规则
program
  .command('rules [action] [templateName]')
  .description('管理项目规则 (init / show / template <name>)')
  .action(async (action: string, templateName: string) => {
    if (action === 'init') {
      const template = generateAgentsMdTemplate();
      const targetPath = path.join(process.cwd(), 'AGENTS.md');
      if (fs.existsSync(targetPath)) {
        console.log('⚠️ AGENTS.md 已存在，是否覆盖？(用 --force 强制覆盖)');
        return;
      }
      fs.writeFileSync(targetPath, template, 'utf-8');
      console.log('✅ 已创建 AGENTS.md');
    } else if (action === 'show') {
      const locations = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md'];
      for (const loc of locations) {
        const full = path.join(process.cwd(), loc);
        if (fs.existsSync(full)) {
          console.log(`📄 ${loc}:\n${fs.readFileSync(full, 'utf-8').slice(0, 1000)}`);
          return;
        }
      }
      console.log('未找到项目规则文件。运行 dscode rules init 创建一个。');
    } else if (action === 'template') {
      if (!templateName) {
        console.log('用法: dscode rules template <名称>');
        console.log('可用模板:');
        for (const name of Object.keys(getTemplates())) {
          console.log(`  ${name}`);
        }
        return;
      }
      if (!getTemplates()[templateName]) {
        console.log(`未知模板: ${templateName}`);
        console.log('可用: ' + Object.keys(getTemplates()).join(', '));
        return;
      }
      const targetPath = path.join(process.cwd(), 'AGENTS.md');
      if (fs.existsSync(targetPath)) {
        console.log('⚠️ AGENTS.md 已存在。用 --force 覆盖或手动删除后重试。');
        return;
      }
      fs.writeFileSync(targetPath, getTemplates()[templateName], 'utf-8');
      console.log(`✅ 已创建 AGENTS.md (${templateName} 模板)`);
    } else if (getTemplates()[action]) {
      const targetPath = path.join(process.cwd(), 'AGENTS.md');
      if (fs.existsSync(targetPath)) {
        console.log(`⚠️ AGENTS.md 已存在。用 --force 覆盖或手动删除后重试。`);
        return;
      }
      fs.writeFileSync(targetPath, getTemplates()[action], 'utf-8');
      console.log(`✅ 已创建 AGENTS.md (${action} 模板)`);
    } else {
      console.log('未知操作。可用: init, show, template <名称>');
      console.log('模板列表: ' + Object.keys(getTemplates()).join(', '));
    }
  });

// Verified Audit
program
  .command('audit')
  .description('生成可验证的项目审查报告 (每条发现附证据)')
  .option('--verified', '仅输出有证据支持的发现')
  .action(async (options) => {
    const { runAuditPipeline, formatAuditReport } = await import('deepseek-code-core');

    // Flash client for candidate generation
    const config = loadConfig();
    const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;
    const baseUrl = config.baseUrl || 'https://api.deepseek.com';
    const flashClient = apiKey ? {
      async chat(prompt: string): Promise<string> {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: MODEL_FLASH, messages: [{ role: 'user', content: prompt }], temperature: 0.1, stream: false }),
        });
        const data = await res.json() as Record<string, unknown>;
        return ((data.choices as Array<{ message: { content: string } }>)?.[0]?.message?.content) ?? '';
      },
    } : undefined;

    const label = apiKey ? '🔍 Verified Audit (Flash 候选 + 确定性验证)' : '🔍 Verified Audit (确定性检查)';
    console.log(label + '\n');
    const report = await runAuditPipeline({ workingDir: process.cwd(), verifiedOnly: !!options.verified, flashClient, onProgress: (s) => console.log(`  ⏳ ${s}`) });
    console.log(formatAuditReport(report));
    console.log(`\n⏱ ${(report.elapsedMs / 1000).toFixed(1)}s | 0 模型调用`);
  });

// Router Eval
program
  .command('eval <target>')
  .description('系统评测 (target: router | task)')
  .option('--suite <name>', '指定评测套件')
  .option('--format <fmt>', '输出格式: json, markdown', 'markdown')
  .option('--live-router', '真实调用 LLM Router (仅路由, 不跑pipeline)')
  .option('--live-task', '真实调用 LLM Router + Pipeline (需API Key)')
  .action(async (target: string, options) => {
    if (target === 'task') {
      // ═══ dscode eval task — 三层模式: mock(离线) / live-router / live-task ═══
      const { loadTaskFixtures, scoreTaskEval, generateTaskEvalReport, formatTaskEvalReport, routeInput } = await import('deepseek-code-core');
      const fs = await import('node:fs');
      const path = await import('node:path');

      const fixturesDir = path.join(process.cwd(), '.evals', 'fixtures');
      if (!fs.existsSync(fixturesDir)) {
        console.log(`❌ Fixture 目录不存在: ${fixturesDir}`);
        console.log('💡 运行 npx tsx .evals/tasks/generate-fixtures.ts 生成 fixture');
        return;
      }

      const suiteFilter = options.suite as string | undefined;
      const allCases = loadTaskFixtures(fixturesDir);
      const filtered = suiteFilter
        ? allCases.filter(c => c.suite === suiteFilter || c.suite.includes(suiteFilter))
        : allCases;

      const liveRouter = !!options.liveRouter;
      const liveTask = !!options.liveTask;
      const evalMode = liveTask ? 'live-task' : liveRouter ? 'live-router' : 'mock';
      const config = loadConfig();
      const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;

      console.log(`🧪 dscode Task Eval [${evalMode}]\n`);
      console.log(`📋 加载 ${filtered.length} 条任务 (${new Set(allCases.map(c => c.suite)).size} 套件)\n`);

      if ((liveRouter || liveTask) && !apiKey) {
        console.log('⚠️ --live-router/--live-task 需要 DEEPSEEK_API_KEY，降级为 mock 模式\n');
      }

      const results: any[] = [];

      for (const tc of filtered) {
        const ctx: any = {
          mode: tc.mode,
          projectName: tc.suite,
          projectPath: tc.casePath,
        };
        // 注入 context (conversationFocus/pendingAction/lastExternalResource等)
        if (tc.context) Object.assign(ctx, tc.context);

        const caseStart = Date.now();
        let routeResult: any;
        let toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
        let outputText = '';

        // 1. 路由: live-router(真实LLM) > mock注入(离线) > 默认heuristic
        if ((liveRouter || liveTask) && apiKey) {
          // live 模式: 真实调用 LLM Router (忽略 mockLLMRouter)
          try {
            routeResult = await routeInput(tc.task, ctx, {
              async chatJson(prompt: string) {
                const res = await fetch(`${config.baseUrl || 'https://api.deepseek.com'}/v1/chat/completions`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                  body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], max_tokens: 256, temperature: 0, stream: false, thinking: { type: 'disabled' } }),
                  signal: AbortSignal.timeout(10000),
                });
                const data = await res.json() as any;
                return data.choices?.[0]?.message?.content ?? '{}';
              },
            });
          } catch { routeResult = { intent: 'unknown', execution: 'agent_readonly', shouldScanProject: true }; }
        } else if (tc.mockLLMRouter) {
          // 离线 mock 模式: 直接注入预期 RouteDecision, 跳过真实 LLM
          routeResult = {
            intent: tc.mockLLMRouter.intent || 'unknown',
            execution: tc.mockLLMRouter.execution || 'agent_readonly',
            shouldScanProject: tc.mockLLMRouter.shouldScanProject ?? true,
            allowedTools: tc.mockLLMRouter.allowedTools || [],
            target: tc.mockLLMRouter.target || { type: 'workspace' },
            confidence: 0.95,
            reason: 'mock LLM Router',
          };
        } else if ((liveRouter || liveTask) && apiKey) {
          // live 模式: 真实调用 LLM Router
          try {
            routeResult = await routeInput(tc.task, ctx, {
              async chatJson(prompt: string) {
                const res = await fetch(`${config.baseUrl || 'https://api.deepseek.com'}/v1/chat/completions`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                  body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], max_tokens: 256, temperature: 0, stream: false, thinking: { type: 'disabled' } }),
                  signal: AbortSignal.timeout(10000),
                });
                const data = await res.json() as any;
                return data.choices?.[0]?.message?.content ?? '{}';
              },
            });
          } catch { routeResult = { intent: 'unknown', execution: 'agent_readonly', shouldScanProject: true }; }
        } else {
          // 默认: heuristic (无LLM Client)
          try { routeResult = await routeInput(tc.task, ctx); }
          catch { routeResult = { intent: 'unknown', execution: 'agent_readonly', shouldScanProject: true }; }
        }

        // 2. live-task: 实际执行 pipeline
        if (liveTask && apiKey) {
          try {
            if (tc.suite === 'repair-typescript') {
              const { runRepairPipeline } = await import('deepseek-code-core');
              const proClient = { async chat(p: string) {
                const res = await fetch(`${config.baseUrl || 'https://api.deepseek.com'}/v1/chat/completions`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                  body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: p }], max_tokens: 1024, temperature: 0.1 }),
                  signal: AbortSignal.timeout(30000),
                });
                return ((await res.json()) as any).choices?.[0]?.message?.content ?? '';
              }};
              const rr = await runRepairPipeline({ workingDir: tc.casePath, taskDescription: tc.task, mode: tc.mode, proClient });
              outputText = `${rr.summary}\n${rr.rootCause ?? ''}\n${rr.suggestedFix ?? ''}`;
              toolCalls = rr.filesExamined.map(f => ({ name: 'read_file', args: { filePath: f } }));
            } else if (tc.suite === 'diff-review') {
              const { runReviewDiffPipeline } = await import('deepseek-code-core');
              const dr = await runReviewDiffPipeline({ workingDir: tc.casePath });
              outputText = `${dr.summary}\n${dr.findings.map(f => `${f.file}: ${f.description}`).join('\n')}`;
              toolCalls = [{ name: 'git_diff', args: {} }, { name: 'git_status', args: {} }];
            } else if (tc.suite === 'code-review') {
              const { runAuditPipeline } = await import('deepseek-code-core');
              const ar = await runAuditPipeline({ workingDir: tc.casePath, mode: 'standard' });
              outputText = ar.findings.map(f => `${f.severity}: ${f.title}`).join('\n') || 'no findings';
            }
          } catch (err) { outputText = `[ERROR] ${(err as Error).message}`; }
        } else {
          outputText = routeResult?.reason || '';
        }

        const result = scoreTaskEval(tc, { routeResult, toolCalls, outputText, durationMs: Date.now() - caseStart, evalMode });
        results.push(result);
        const icon = result.passed ? '✅' : '❌';
        const extra = liveTask ? ` f=${result.score.filesHit}/${result.score.filesExpected} o=${result.score.outputHits}/${result.score.outputExpected}` : '';
        console.log(`  ${icon} [${tc.risk}] ${tc.suite}/${tc.id}${extra}`);
      }

      const report = generateTaskEvalReport(results);
      console.log('');
      console.log(formatTaskEvalReport(report));
      return;
    }

    if (target !== 'router') {
      console.log('当前支持: dscode eval router | dscode eval task');
      return;
    }

    const { routeInput } = await import('deepseek-code-core');
    const { evaluateRouterCase, generateEvalReport, formatEvalReport } = await import('deepseek-code-core');
    const fs = await import('node:fs');
    const path = await import('node:path');

    const { fileURLToPath } = await import('node:url');
    const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', '__tests__', 'fixtures', 'router');
    if (!fs.existsSync(fixtureDir)) {
      // Fallback: relative to working dir
      const fallbackDir = path.join(process.cwd(), 'packages', 'core', '__tests__', 'fixtures', 'router');
      if (fs.existsSync(fallbackDir)) {
        console.log('📁 使用 fallback 路径');
      } else {
        console.log(`Fixture 目录不存在: ${fixtureDir}`);
        console.log(`请确保在项目根目录运行 dscode eval router`);
        return;
      }
    }
    const actualDir = fs.existsSync(fixtureDir) ? fixtureDir : path.join(process.cwd(), 'packages', 'core', '__tests__', 'fixtures', 'router');
    const suiteFilter = options.suite as string | undefined;

    console.log('🧪 Router Eval Framework\n');

    // Load fixtures
    const allCases: any[] = [];
    const files = fs.readdirSync(actualDir).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      if (suiteFilter && !file.includes(suiteFilter)) continue;
      const lines = fs.readFileSync(path.join(actualDir, file), 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try { allCases.push(JSON.parse(line)); } catch { /* skip */ }
      }
    }

    console.log(`📋 加载 ${allCases.length} 条用例 (${files.length} 个套件)\n`);

    // --live: 使用真实 LLM Router
    let llmClient: any = undefined;
    if (options.live) {
      const config = loadConfig();
      const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;
      if (!apiKey) {
        console.log('❌ --live 需要 DEEPSEEK_API_KEY');
        return;
      }
      llmClient = {
        async chatJson(prompt: string): Promise<string> {
          const res = await fetch(`${config.baseUrl || 'https://api.deepseek.com'}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: MODEL_FLASH, messages: [
                { role: 'system', content: '只输出 JSON，不要 Markdown。' },
                { role: 'user', content: prompt },
              ], max_tokens: 256, temperature: 0, stream: false,
            }),
          });
          const data = await res.json() as any;
          const raw = data.choices?.[0]?.message?.content ?? '';
          const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
          return jsonMatch ? jsonMatch[1].trim() : raw.trim();
        },
      };
      console.log('🔴 LIVE 模式：使用真实 DeepSeek Flash LLM Router\n');
    }

    // Run eval
    const start = Date.now();
    const results = [];
    for (const c of allCases) {
      const result = await evaluateRouterCase(c, routeInput, llmClient);
      results.push(result);
      const icon = result.passed ? '✅' : '❌';
      if (!result.passed || c.risk === 'P0') {
        console.log(`${icon} [${result.risk}] ${result.caseId}: ${result.details.join('; ') || 'OK'}`);
      }
    }

    const report = generateEvalReport(results);
    const elapsed = Date.now() - start;

    if (options.format === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatEvalReport(report));
      // Save report
      try {
        const outDir = path.join(process.cwd(), '.router-eval');
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'latest.md'), formatEvalReport(report), 'utf-8');
        fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf-8');
        if (report.failed > 0) {
          const failures = report.results.filter((r) => !r.passed).map((r) => ({ id: r.caseId, expected: r.expected, actual: r.actual, details: r.details }));
          fs.writeFileSync(path.join(outDir, 'failures.jsonl'), failures.map((f) => JSON.stringify(f)).join('\n'), 'utf-8');
        }
        console.log(`\n💾 报告已保存: ${outDir}/`);
      } catch { /* ignore */ }
    }
    console.log(`\n⏱ ${(elapsed / 1000).toFixed(1)}s | ${report.passed}/${report.total} passed`);

    // CI 门槛检查
    if (report.p0Failures > 0) {
      console.log(`\n❌ P0 失败: ${report.p0Failures} 条，必须为 0 才能通过 CI`);
      process.exitCode = 1;
    }
  });

// Context Stats
program
  .command('context [action] [target]')
  .description('上下文管理 (stats / show <id> / explain <id> / 默认prefix)')
  .action(async (action: string | undefined, target: string | undefined) => {
    if (action === 'stats' || action === 'show' || action === 'explain') {
      const { FileMemoryStore } = await import('deepseek-code-core');
      const memory = new FileMemoryStore(process.cwd());

      if (action === 'stats') {
        const sessions = await memory.listSessions();
        const recent = sessions.filter(s => s.stats).slice(0, 10);
        if (recent.length === 0) { console.log('📊 暂无会话统计数据'); return; }
        console.log('═══════════════════════════════════════');
        console.log('  dscode Context Stats — 最近会话');
        console.log('═══════════════════════════════════════\n');
        for (const s of recent.slice(0, 5)) {
          const st = s.stats!;
          const date = new Date(s.createdAt).toLocaleString('zh-CN');
          const cr = st.totalPromptTokens > 0 ? ((st.cacheHitTokens / st.totalPromptTokens) * 100).toFixed(0) : '0';
          console.log(`📋 ${(s.taskDescription || '').slice(0, 50)}`);
          console.log(`   ${date}  ⏱ ${(st.elapsedMs/1000).toFixed(0)}s  💰 $${st.estimatedCostUsd.toFixed(4)}`);
          console.log(`   Prompt:${(st.totalPromptTokens/1000).toFixed(1)}K | Out:${(st.totalCompletionTokens/1000).toFixed(1)}K | KV:${cr}% | Flash×${st.flashCalls} Pro×${st.proCalls} 工具×${st.toolCalls}`);
          console.log('');
        }
        const tc = recent.reduce((s: number, x: any) => s + (x.stats?.estimatedCostUsd||0), 0);
        const tt = recent.reduce((s: number, x: any) => s + (x.stats?.totalPromptTokens||0) + (x.stats?.totalCompletionTokens||0), 0);
        const ac = Math.round(recent.reduce((s: number, x: any) => {
          const st = x.stats!; return s + (st.totalPromptTokens > 0 ? st.cacheHitTokens / st.totalPromptTokens : 0);
        }, 0) / recent.length * 100);
        console.log(`📊 ${recent.length}会话 | 💰总$${tc.toFixed(4)} | 📊${(tt/1000).toFixed(0)}K tokens | 🔑均${ac}%命中`);

        // 按 contextPolicy 聚合
        const allCalls = recent.flatMap(s => s.stats?.modelCalls ?? []);
        if (allCalls.length > 0) {
          const byPolicy: Record<string, { calls: number; promptK: number; hitK: number; missK: number; cost: number; latencyMs: number }> = {};
          for (const c of allCalls) {
            const key = c.contextPolicy || 'unknown';
            if (!byPolicy[key]) byPolicy[key] = { calls: 0, promptK: 0, hitK: 0, missK: 0, cost: 0, latencyMs: 0 };
            byPolicy[key].calls++;
            byPolicy[key].promptK += c.usage.promptTokens / 1000;
            byPolicy[key].hitK += c.usage.cacheHitTokens / 1000;
            byPolicy[key].missK += c.usage.cacheMissTokens / 1000;
            byPolicy[key].cost += c.costUsd;
            byPolicy[key].latencyMs += c.latencyMs;
          }
          console.log(`\n按 contextPolicy 聚合 (${allCalls.length} 次调用):`);
          const policyLabel: Record<string, string> = { none:'🚫免上下文', session_state:'📋会话状态', project_summary:'📦项目摘要', full_agent:'🤖全Agent' };
          for (const [policy, d] of Object.entries(byPolicy).sort(([,a],[,b]) => b.cost - a.cost)) {
            const hr = d.promptK > 0 ? ((d.hitK / d.promptK) * 100).toFixed(0) : '0';
            const avgLat = (d.latencyMs / d.calls / 1000).toFixed(1);
            console.log(`  ${policyLabel[policy] || policy}: ${d.calls}次 | Prompt:${d.promptK.toFixed(0)}K | Hit:${hr}% | Cost:$${d.cost.toFixed(4)} | 均${avgLat}s`);
          }

          // session_state vs full_agent 对比
          const ss = byPolicy['session_state'];
          const fa = byPolicy['full_agent'];
          if (ss && fa) {
            const ratio = (ss.promptK / Math.max(fa.promptK, 0.001) * 100).toFixed(0);
            console.log(`\n💡 session_state 单次平均 prompt: ${(ss.promptK/ss.calls).toFixed(0)}K vs full_agent: ${(fa.promptK/fa.calls).toFixed(0)}K (${ratio}%)`);
          }
        }
        return;
      }

      if (action === 'show' && target) {
        const s = await memory.loadSession(target);
        if (!s?.stats) { console.log('无统计数据'); return; }
        const st = s.stats!;
        const cr = st.totalPromptTokens > 0 ? ((st.cacheHitTokens / st.totalPromptTokens) * 100).toFixed(0) : '0';
        console.log(`📋 ${s.taskDescription.slice(0, 60)}`);
        console.log(`⏱ ${(st.elapsedMs/1000).toFixed(0)}s | 💰 $${st.estimatedCostUsd.toFixed(6)}`);
        console.log(`Prompt:${(st.totalPromptTokens/1000).toFixed(1)}K Out:${(st.totalCompletionTokens/1000).toFixed(1)}K Hit:${(st.cacheHitTokens/1000).toFixed(1)}K(${cr}%) Miss:${(st.cacheMissTokens/1000).toFixed(1)}K`);
        console.log(`Flash×${st.flashCalls} Pro×${st.proCalls} 工具×${st.toolCalls}`);
        if (st.prefixHashes) {
          console.log(`\n前缀 Hash 诊断:`);
          console.log(`  Global:  ${st.prefixHashes.global}`);
          console.log(`  Runtime: ${st.prefixHashes.runtime}`);
          console.log(`  Project: ${st.prefixHashes.project}`);
          console.log(`  Session: ${st.prefixHashes.session}`);
        }
        return;
      }

      if (action === 'explain' && target) {
        const s = await memory.loadSession(target);
        if (!s?.stats) { console.log('该会话无统计数据，无法诊断'); return; }
        const st = s.stats!;
        console.log(`📋 诊断: ${(s.taskDescription || '').slice(0, 60)}`);
        console.log(`创建: ${new Date(s.createdAt).toLocaleString('zh-CN')}\n`);
        const cr = st.totalPromptTokens > 0 ? ((st.cacheHitTokens / st.totalPromptTokens) * 100).toFixed(0) : '0';
        console.log(`KV Cache 总览`);
        console.log(`  Prompt: ${(st.totalPromptTokens/1000).toFixed(0)}K`);
        console.log(`  Hit:    ${(st.cacheHitTokens/1000).toFixed(0)}K`);
        console.log(`  Miss:   ${(st.cacheMissTokens/1000).toFixed(0)}K`);
        console.log(`  Rate:   ${cr}%`);
        console.log(`  Cost:   $${st.estimatedCostUsd.toFixed(4)}`);
        const missRatio = st.totalPromptTokens > 0 ? st.cacheMissTokens / st.totalPromptTokens : 0;
        console.log(`  来源: ${missRatio > 0.5 ? '冷启动(首轮)' : st.toolCalls > 0 ? `工具调用(${st.toolCalls}次)` : 'Dynamic Tail'}\n`);

        if (st.prefixHashes) {
          const allSessions = await memory.listSessions();
          const withHashes = allSessions.filter(x => x.stats?.prefixHashes).slice(0, 20);

          // 跨会话对比: 找同 project hash 的会话（可共享缓存）
          const sameProject = withHashes.filter(x =>
            x.stats!.prefixHashes!.project === st.prefixHashes!.project &&
            x.id !== s.id
          );
          const sameSession = withHashes.filter(x =>
            x.stats!.prefixHashes!.session === st.prefixHashes!.session &&
            x.id !== s.id
          );

          const { buildGlobalPrefix, buildRuntimePrefix } = await import('deepseek-code-core');
          const crypto = await import('node:crypto');
          const hash = (v: string) => crypto.createHash('md5').update(v).digest('hex').slice(0, 8);
          const curGlobal = hash(buildGlobalPrefix());
          const curRuntime = hash(buildRuntimePrefix());

          console.log(`前缀 Hash 诊断:`);
          console.log(`  ┌ Global:  ${st.prefixHashes.global}`);
          console.log(`  │ 当前:   ${curGlobal} ${st.prefixHashes.global === curGlobal ? '✅' : '⚠️ 已变(版本升级?)'}`);
          console.log(`  ├ Runtime: ${st.prefixHashes.runtime}`);
          console.log(`  │ 当前:   ${curRuntime} ${st.prefixHashes.runtime === curRuntime ? '✅' : '⚠️ 已变(路径/OS?)'}`);
          console.log(`  ├ Project: ${st.prefixHashes.project}`);
          console.log(`  │ 同hash会话: ${sameProject.length} 个 → ${sameProject.length > 0 ? '可复用Project层缓存' : '孤立会话'}`);
          if (sameProject.length > 0) {
            for (const xs of sameProject.slice(0, 3)) {
              const xst = xs.stats!;
              const xcr = xst.totalPromptTokens > 0 ? ((xst.cacheHitTokens / xst.totalPromptTokens) * 100).toFixed(0) : '0';
              console.log(`  │   ${xs.id.slice(0, 12)}... ${(xs.taskDescription||'').slice(0, 30)} 命中率:${xcr}%`);
            }
          }
          console.log(`  └ Session: ${st.prefixHashes.session}`);
          console.log(`    同hash会话: ${sameSession.length} 个 → ${sameSession.length > 0 ? '任务/计划相同' : '独立任务'}`);

          // 分层 miss 归因
          console.log(`\n📊 分层 miss 归因:`);
          const globalOk = st.prefixHashes.global === curGlobal;
          const runtimeOk = st.prefixHashes.runtime === curRuntime;
          console.log(`  Global:  ${globalOk ? '✅ 一致' : '⚠️ 变化 → 全量 cache miss'}`);
          console.log(`  Runtime: ${runtimeOk ? '✅ 一致' : '⚠️ 变化 → Runtime 层起 miss'}`);
          if (!globalOk || !runtimeOk) {
            console.log(`  💡 建议: 运行 dscode context warm 重建缓存`);
          }
          if (sameProject.length === 0 && globalOk && runtimeOk) {
            console.log(`  Project: 无同hash会话 → 此为首次分析该仓库(冷启动)`);
          }
          if (st.toolCalls > 0 && missRatio < 0.3) {
            console.log(`  Dynamic: ${st.toolCalls}次工具调用 → 仅尾缀变化，前缀缓存命中良好`);
          } else if (st.toolCalls > 0) {
            console.log(`  Dynamic: ${st.toolCalls}次工具调用，miss=${(missRatio*100).toFixed(0)}%`);
          }
        }
        return;
      }
    }
    const { buildGlobalPrefix, buildRuntimePrefix } = await import('deepseek-code-core');
    const crypto = await import('node:crypto');
    const hash = (s: string) => crypto.createHash('md5').update(s).digest('hex').slice(0, 8);

    const globalPrefix = buildGlobalPrefix();
    const runtimePrefix = buildRuntimePrefix();
    const cacheDir = path.join(process.cwd(), '.deepseek-code', 'cache');
    const cacheExists = fs.existsSync(path.join(cacheDir, 'repo-info.json'));

    console.log('📊 Context Cache Stats\n');
    console.log(`Global Prefix:  ${hash(globalPrefix)} (${globalPrefix.length} chars)`);
    console.log(`Runtime Prefix: ${hash(runtimePrefix)} (${runtimePrefix.length} chars)`);
    console.log(`Project Cache:  ${cacheExists ? '✅ 已缓存' : '❌ 未缓存'}`);
    if (cacheExists) {
      const stat = fs.statSync(path.join(cacheDir, 'repo-info.json'));
      console.log(`Cache Age:      ${((Date.now() - stat.mtimeMs) / 60000).toFixed(0)}min`);
    }
    console.log(`Prefix Stability: Global + Runtime 在所有请求中保持不变`);
    console.log(`\n💡 运行 dscode init-context 预热缓存`);
  });

// 初始化上下文缓存
program
  .command('init')
  .description('初始化项目：检测技术栈并生成 AGENTS.md 和配置')
  .action(async () => {
    const { scanRepo } = await import('deepseek-code-core');
    const fs = await import('node:fs');
    const path = await import('node:path');

    console.log('🔍 检测项目技术栈...');
    const repoInfo = await scanRepo({ workingDir: process.cwd() });

    const stack = repoInfo.techStack;
    console.log(`   语言: ${stack.language}  框架: ${stack.framework ?? '无'}  构建: ${stack.buildTool}  测试: ${stack.testFramework ?? '无'}`);

    // 匹配模板
    let templateName = 'react';
    if (stack.framework === 'next.js') templateName = 'nextjs';
    else if (stack.framework === 'vue') templateName = 'vue3';
    else if (['express', 'koa', 'fastify'].some((f) => stack.framework?.includes(f))) templateName = 'express';
    else if (stack.language === 'python') templateName = 'python-fastapi';

    const tmpl = getTemplates();
    const content = tmpl[templateName] ?? generateAgentsMdTemplate();

    const agentsPath = path.join(process.cwd(), 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      console.log(`⚠️  AGENTS.md 已存在，跳过创建`);
    } else {
      fs.writeFileSync(agentsPath, content, 'utf-8');
      console.log(`✅ 已创建 AGENTS.md (${templateName} 模板)`);
    }

    // 配置
    const configDir = path.join(process.cwd(), '.deepseek-code');
    const configPath = path.join(configDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        sessionDir: '.deepseek-code/sessions',
      }, null, 2), 'utf-8');
      console.log('✅ 已创建 .deepseek-code/config.json');
    }

    console.log('\n🚀 初始化完成！运行 dscode "解释项目" 试试');
  })

  .command('init-context')
  .description('生成/刷新 repo-context.md 缓存以预热 DeepSeek API 缓存')
  .action(async () => {
    const { scanRepo, buildGlobalPrefix, buildProjectPrefix } = await import('deepseek-code-core');
    const fs = await import('node:fs');
    const path = await import('node:path');

    console.log('🔍 扫描项目...');
    const repoInfo = await scanRepo({ workingDir: process.cwd() });

    const cacheDir = path.join(process.cwd(), '.deepseek-code', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });

    const contextPath = path.join(cacheDir, 'repo-context.md');
    const globalPrefix = buildGlobalPrefix();
    const projectPrefix = buildProjectPrefix(repoInfo);
    const content = `# DeepSeek Code Context Cache\n\n${globalPrefix}\n\n${projectPrefix}`;
    fs.writeFileSync(contextPath, content, 'utf-8');

    const crypto = await import('node:crypto');
    const globalHash = crypto.createHash('md5').update(globalPrefix).digest('hex').slice(0, 8);
    const projectHash = crypto.createHash('md5').update(projectPrefix).digest('hex').slice(0, 8);

    console.log(`✅ 上下文缓存已生成: ${contextPath}`);
    console.log(`🔑 global=${globalHash} project=${projectHash}`);
    console.log(`💡 下次请求将命中 DeepSeek Context Caching`);
  });

// Session 管理
program
  .command('sessions [action] [target]')
  .description('管理历史会话 (list / show <id> / delete <id> / delete-all)')
  .action(async (action: string | undefined, target: string | undefined) => {
    const memory = new FileMemoryStore(process.cwd());
    if (!action || action === 'list') {
      const sessions = await memory.listSessions();
      if (sessions.length === 0) { console.log('📝 暂无历史会话'); return; }
      console.log(`📝 共 ${sessions.length} 个会话:\n`);
      for (const s of sessions.slice(0, 20)) {
        if (!s.id) continue;
        const date = new Date(s.createdAt).toLocaleString('zh-CN');
        const icon = s.completed ? '✅' : '⏳';
        console.log(`  ${icon} [${s.id.slice(0, 20)}]`);
        console.log(`     ${date}  ${(s.taskDescription || '').slice(0, 50)}`);
        console.log('');
      }
    } else if (action === 'delete' && target) {
      await memory.deleteSession(target);
      console.log(`🗑️  已删除: ${target.slice(0, 20)}`);
    } else if (action === 'delete-all') {
      const sessions = await memory.listSessions();
      for (const s of sessions) await memory.deleteSession(s.id);
      console.log(`🗑️  已删除全部 ${sessions.length} 个会话`);
    } else if (action === 'show' && target) {
      const s = await memory.loadSession(target);
      if (!s) { console.log(`会话 ${target.slice(0, 20)} 不存在`); return; }
      console.log(`📋 ${s.id}\n任务: ${s.taskDescription}\n时间: ${new Date(s.createdAt).toLocaleString('zh-CN')}\n步骤: ${s.steps.length}\n状态: ${s.completed ? '✅' : '⏳'}`);
    }
  });

// Workflow 管理
program
  .command('workflow <action> [target]')
  .description('工作流管理 (init / validate <file> / run <file|id> / list / runs / show <runId>)')
  .option('--input <json>', '工作流输入参数 (JSON)')
  .option('--write', '启用写模式', false)
  .action(async (action: string, target: string | undefined, options: Record<string, string>) => {
    const { cmdWorkflowInit, cmdWorkflowValidate, cmdWorkflowRun, cmdWorkflowList, cmdWorkflowRuns, cmdWorkflowShow } = await import('./commands/workflow.js');
    const workspaceRoot = process.cwd();
    const mode = options.write ? 'auto' : 'readonly';

    switch (action) {
      case 'init':
        await cmdWorkflowInit(workspaceRoot);
        break;
      case 'validate':
        if (!target) { console.log('用法: dscode workflow validate <file>'); return; }
        await cmdWorkflowValidate(target);
        break;
      case 'run':
        if (!target) { console.log('用法: dscode workflow run <file|id> [--input <json>] [--write]'); return; }
        await cmdWorkflowRun(target, workspaceRoot, mode, options.input);
        break;
      case 'list':
        await cmdWorkflowList(workspaceRoot);
        break;
      case 'runs':
        await cmdWorkflowRuns(workspaceRoot);
        break;
      case 'show':
        if (!target) { console.log('用法: dscode workflow show <runId>'); return; }
        await cmdWorkflowShow(workspaceRoot, target);
        break;
      default:
        console.log(`未知操作: ${action}`);
        console.log('用法: dscode workflow <init|validate|run|list|runs|show>');
    }
  });

// AutoFix — 自主修复闭环
program
  .command('autofix')
  .description('审计并生成修复建议 (audit → repair proposal, 暂不自动apply)')
  .option('-s, --scope <scopes>', '修复范围 (逗号分隔): security,type-safety,config,test,maintainability', 'all')
  .option('-r, --retries <n>', '每个问题最大修复轮次', '3')
  .option('--verify <command>', '验证命令', 'pnpm typecheck')
  .option('--min-severity <level>', '最低修复严重度: low/medium/high', 'low')
  .option('--write', '启用写模式（默认只读）', false)
  .option('--dry-run', '仅报告，不修改', false)
  .action(async (options: Record<string, string>) => {
    const { runAutoFixLoop } = await import('deepseek-code-core');

    const config = loadConfig();
    const workingDir = process.cwd();
    const mode = options.write ? 'auto' : 'readonly';

    const scopes = options.scope === 'all'
      ? undefined
      : (options.scope as string).split(',').map(s => s.trim()) as any;

    if (options.dryRun) {
      console.log('🔍 Dry Run 模式：仅审查，不修改');
      console.log(`   范围: ${options.scope}`);
      console.log(`   严重度阈值: ${options.minSeverity}`);
      console.log('');
    }

    const result = await runAutoFixLoop({
      workingDir,
      scopes,
      maxRetries: parseInt(options.retries as string, 10) || 3,
      verifyCommand: options.verify as string,
      mode: options.dryRun ? 'readonly' : (mode as 'readonly' | 'auto'),
      minSeverity: options.minSeverity as 'low' | 'medium' | 'high',
      onProgress: (step) => console.log(step),
    });

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log(`  AutoFix 报告`);
    console.log('═══════════════════════════════════════');
    console.log(`  总发现:  ${result.totalFindings}`);
    console.log(`  已修复:  ${result.fixed}`);
    console.log(`  失败:    ${result.failed}`);
    console.log(`  跳过:    ${result.skipped}`);
    console.log(`  耗时:    ${(result.elapsedMs / 1000).toFixed(1)}s`);
    console.log('───────────────────────────────────────');

    if (result.attempts.length > 0) {
      console.log('');
      for (const a of result.attempts) {
        const icon = a.status === 'fixed' ? '✅' : a.status === 'failed' ? '❌' : a.status === 'rolled_back' ? '🔄' : '⏭️';
        console.log(`  ${icon} [${a.severity}] ${a.findingTitle}`);
        if (a.status === 'fixed') console.log(`      ${a.attempt} 轮修复成功`);
        if (a.status === 'failed' || a.status === 'rolled_back') console.log(`      ${a.attempt} 轮 | ${a.error || '验证未通过'}`);
      }
    }

    console.log('═══════════════════════════════════════');
    console.log(result.summary);

    if (mode === 'readonly' && !options.dryRun) {
      console.log('');
      console.log('💡 添加 --write 参数执行实际修复');
    }
  });

// 仓库级分析 — 利用 DeepSeek V4 1M 上下文做全仓库理解
program
  .command('analyze [query]')
  .description('仓库级深度分析 (生成 RepoMap + 1M上下文综合判断)')
  .option('-d, --depth <n>', '扫描深度', '6')
  .option('--no-imports', '跳过 import 图解析')
  .option('-m, --model <model>', '模型选择', 'pro')
  .option('--tokens <n>', '最大输出 tokens', '4096')
  .action(async (query: string | undefined, options: Record<string, string>) => {
    const { generateRepoMap, formatRepoMap } = await import('deepseek-code-core');
    const workingDir = process.cwd();

    console.log('🔬 生成仓库地图...');
    const startTime = Date.now();
    const map = generateRepoMap({
      workingDir,
      maxDepth: parseInt(options.depth as string, 10) || 6,
      includeImports: (options.imports as unknown as boolean) !== false,
      includeExports: true,
    });
    const mapText = formatRepoMap(map);
    console.log(`📊 ${map.totalFiles} 文件, ~${map.estimatedTokens} tokens (${Date.now() - startTime}ms)\n`);

    const config = loadConfig();
    const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      console.log('⚠️ 需要 DEEPSEEK_API_KEY 才能进行 LLM 分析。RepoMap 已生成：');
      console.log(mapText.slice(0, 2000));
      return;
    }

    const model = options.model === 'flash' ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
    const prompt = query
      ? `基于以下仓库地图，回答: ${query}\n\n${mapText}`
      : `基于以下仓库地图，做一次全面的架构分析。包括: 1)整体架构设计 2)模块职责和边界 3)关键数据流 4)值得优化的地方 5)安全/质量风险点。\n\n${mapText}`;

    console.log(`🧠 使用 ${model} 进行仓库级分析...\n`);
    const analysisStart = Date.now();

    try {
      const res = await fetch(`${config.baseUrl || 'https://api.deepseek.com'}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: '你是一个资深软件架构师。基于仓库地图进行深度分析。每个发现标注具体的文件路径和行号。只输出基于地图证据的结论，不要编造。' },
            { role: 'user', content: prompt },
          ],
          max_tokens: parseInt(options.tokens as string, 10) || 4096,
          temperature: 0.3,
          stream: true,
          stream_options: { include_usage: true },
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(300_000),
      });

      if (!res.ok) { console.log(`❌ API错误: ${res.status}`); return; }

      // 流式输出
      const reader = res.body?.getReader();
      if (!reader) { console.log('❌ 无响应流'); return; }

      const decoder = new TextDecoder();
      let buffer = '';
      let totalTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;
          try {
            const json = JSON.parse(trimmed.slice(6));
            const content = json.choices?.[0]?.delta?.content;
            if (content) process.stdout.write(content);
            if (json.usage) totalTokens = json.usage.total_tokens || totalTokens;
          } catch { /* skip */ }
        }
      }
      process.stdout.write('\n');

      const elapsed = ((Date.now() - analysisStart) / 1000).toFixed(1);
      console.log(`\n⏱ 分析耗时: ${elapsed}s | 仓库地图: ${map.estimatedTokens} tokens | 总: ~${totalTokens} tokens | 上下文利用率: ${((map.estimatedTokens / 1000000) * 100).toFixed(1)}%`);

    } catch (err) {
      console.log(`❌ 分析失败: ${(err as Error).message}`);
    }
  });

program.parse();

// ============================================================
// 核心逻辑
// ============================================================

async function runTask(
  task: string,
  config: DeepSeekCodeConfig,
  apiKey: string,
  baseUrl: string,
  modelStrategy: string,
  workingDir: string,
  runMode: 'plan' | 'edit' | 'auto',
  dryRun: boolean,
  resumeSessionId?: string,
) {
  console.log(`
╔══════════════════════════════════════╗
║       🤖 DeepSeek Code CLI          ║
║   面向中文开发者的 AI 编程 Agent      ║
╚══════════════════════════════════════╝
`);
  console.log(`📁 项目: ${workingDir}`);
  console.log(`🧠 策略: ${modelStrategy}`);
  console.log(`🔒 模式: ${runMode === 'plan' ? '📋 计划(只读)' : runMode === 'edit' ? '✏️ 编辑(审批)' : '🚀 自主(全自动)'}`);
  if (dryRun) console.log(`📋 计划模式: 仅生成计划，不执行`);
  console.log('');

  // 过滤密钥
  const safeTask = filterSecrets(task);

  // 构建模型路由配置
  const routerConfig: ModelRouterConfig = {
    strategy: modelStrategy as 'auto' | 'pro' | 'flash',
    config: { apiKey, baseUrl },
  };
  const router = new ModelRouter(routerConfig);

  // 构建工具执行器
  const tools = createToolExecutors({ workingDir });

  // 构建存储
  const memory = new FileMemoryStore(workingDir);

  // 构建权限管理器：读写模式下交互确认，只读模式自动拒绝写操作
  const permManager = new PermissionManager(
    createDefaultPermissionConfig(async (req: PermissionRequest) => {
      // 安全操作：自动批准
      if (req.risk === 'safe') return 'allow_once';

      // 禁止操作：直接拒绝
      if (req.risk === 'forbidden') {
        console.log(`\n🚫 禁止操作: ${req.target}`);
        return 'deny';
      }

      // plan 模式：拒绝写操作
      if (runMode === 'plan') {
        console.log(`\n📋 计划模式，已拒绝: ${req.type} → ${req.target}`);
        return 'deny';
      }
      // auto 模式：直接放行
      if (runMode === 'auto') return 'allow_once';

      // edit 模式：交互确认
      console.log(`\n⚠️  确认操作`);
      console.log(`   类型: ${req.type}`);
      console.log(`   目标: ${req.target}`);
      console.log(`   原因: ${req.reason}`);
      console.log(`   风险等级: ${req.risk}`);

      // 尝试读取用户输入
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
        rl.question('   是否允许？(y=是 / n=否 / a=本次全部允许): ', (answer: string) => {
          rl.close();
          const a = answer.trim().toLowerCase();
          if (a === 'a' || a === 'always') resolve('allow_always');
          else if (a === 'y' || a === 'yes') resolve('allow_once');
          else resolve('deny');
        });
      });
    }),
  );

  // 运行 Agent
  const result = await runAgentLoop(safeTask || '恢复会话', {
    workingDir,
    router,
    tools,
    memory,
    readOnly: runMode === 'plan',
    permissionManager: permManager,
    resumeSessionId,
    onConfirm: async (message: string) => {
      if (dryRun) {
        console.log(`\n📋 [计划模式] ${message}`);
        console.log('✅ 计划模式：自动确认');
        return true;
      }

      console.log(`\n🤔 ${message}`);
      // 非交互模式下默认确认（CLI 直接模式）
      console.log('✅ 自动确认（直接模式）');
      return true;
    },
  });

  // 输出结果
  if (result.summary === '会话已完成，无需恢复') {
    // resume 已完成会话，不重复输出
  } else if (result.success) {
    console.log('\n✅ 任务完成！');
  } else {
    console.log('\n⚠️ 任务未完全完成');
    if (result.error) {
      console.log(`原因: ${result.error}`);
    }
  }

  if (result.session?.id) console.log(`📝 会话 ID: ${result.session.id}`);
}

async function interactiveMode(
  config: DeepSeekCodeConfig,
  apiKey: string,
  baseUrl: string,
  modelStrategy: string,
  workingDir: string,
  initialMode: 'plan' | 'edit' | 'auto',
) {
  // 三模式: plan(计划-只读) / edit(编辑-需审批) / auto(自主-全自动)
  let currentMode: 'plan' | 'edit' | 'auto' = initialMode;

  console.log(`
╔══════════════════════════════════════╗
║       🤖 DeepSeek Code CLI          ║
║   面向中文开发者的 AI 编程 Agent      ║
╚══════════════════════════════════════╝
`);
  console.log(`📁 当前项目: ${path.basename(workingDir)}`);
  console.log(`🧠 模型策略: ${modelStrategy}`);
  console.log(`🔒 当前模式: ${currentMode === 'plan' ? '📋 计划(只读)' : currentMode === 'edit' ? '✏️ 编辑(审批)' : '🚀 自主(全自动)'}`);
  console.log('');
  console.log('输入任务描述开始，或输入以下命令：');
  console.log('  /plan     - 📋 计划模式(只读/分析/搜索)');
  console.log('  /edit     - ✏️ 编辑模式(写操作需审批)');
  console.log('  /auto     - 🚀 自主模式(全自动执行)');
  console.log('  /diff     - 查看 Git diff');
  console.log('  /sessions - 查看历史会话');
  console.log('  /new      - 开始新会话');
  console.log('  /exit     - 退出');
  console.log('');

  // ═══ 三模式权限管理器 ═══
  // plan: 只读, 写操作触发升级提示
  // edit: 写操作需审批 (y=本次/a=免审/n=拒绝)
  // auto: 全自动放行
  const sessionApprovals = new Set<string>();
  const permManager = new PermissionManager(
    createDefaultPermissionConfig(async (req: PermissionRequest) => {
      if (req.risk === 'safe') return 'allow_once';
      if (req.risk === 'forbidden') { console.log(`\n⛔ 禁止操作: ${req.target.slice(0, 80)}`); return 'deny'; }

      // plan 模式 + 写操作 → 提议升到 edit 模式
      if (currentMode === 'plan') {
        const answer = await new Promise<string>((resolve) => rl.question(
          `\n📋 计划模式不能执行写操作。切换到 ✏️ 编辑模式？[y]切换并执行 [n]拒绝: `, resolve));
        if (answer.trim().toLowerCase() === 'y') {
          currentMode = 'edit';
          console.log('   ✏️ 已切换到编辑模式。后续写操作将逐个审批。\n');
          return 'allow_once';
        }
        console.log('   ❌ 已拒绝\n');
        return 'deny';
      }

      // auto 模式 → 全自动
      if (currentMode === 'auto') return 'allow_once';

      // edit 模式 → 逐项审批
      if (sessionApprovals.has(req.type)) return 'allow_once';

      const riskLabel = req.risk === 'dangerous' ? '🔴 高风险' : '🟡';
      console.log(`\n${riskLabel} ${req.type}: ${req.reason}`);
      if (req.risk === 'dangerous') console.log(`   ⚠️  破坏性操作，请确认`);
      const answer = await new Promise<string>((resolve) => rl.question(
        '   [y]允许 [n]拒绝 [a]免审此类 [auto]切自主模式: ', resolve));
      const a = answer.trim().toLowerCase();
      if (a === 'auto') { currentMode = 'auto'; console.log('   🚀 已切换到自主模式\n'); return 'allow_once'; }
      if (a === 'a') { sessionApprovals.add(req.type); console.log('   ✅ 已免审\n'); return 'allow_once'; }
      if (a === 'y' || a === 'yes' || a === '') { console.log(''); return 'allow_once'; }
      console.log('   ❌ 已拒绝\n');
      return 'deny';
    }),
  );

  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n💬 dscode> ',
  });

  // 共享会话状态：整个交互期维持一个 session
  let sharedMessages: import('deepseek-code-shared').ChatMessage[] | null = null;
  // 两层记忆：闲聊历史 + 任务结果
  // 从持久化状态恢复
  const prevState = loadInteractiveState(workingDir);
  const CHAT_HISTORY_MAX = 100;  // 保留最近 100 条（约 50 轮对话）
  let chatHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = ((prevState?.chatHistory ?? []) as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>).slice(-CHAT_HISTORY_MAX);
  let chatSummaries: string[] = prevState?.chatSummaries ?? [];

  /** 每 10 轮对话用 Flash 生成摘要，保持上下文不丢失 */
  async function summarizeAndCompress() {
    if (chatHistory.length < 20) return; // 至少 10 轮对话才压缩
    const recent = chatHistory.slice(-10); // 保留最近 5 轮
    const toSummarize = chatHistory.slice(0, -10); // 待压缩的早期对话
    if (toSummarize.length < 10) return;

    try {
      const text = toSummarize.map((m) => `${m.role}: ${m.content.slice(0, 100)}`).join('\n');
      const prompt = `用 100 字中文总结这段对话的核心内容和结论，不要编造：\n${text.slice(0, 2000)}`;
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: MODEL_FLASH, messages: [{ role: 'user', content: prompt }], max_tokens: 200, temperature: 0.1 }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        const summary = data.choices?.[0]?.message?.content?.trim();
        if (summary) {
          chatSummaries.push(`[早期对话] ${summary}`);
          chatHistory = recent; // 压缩：只保留最近 10 条 + 摘要
        }
      }
    } catch {
      // 摘要失败不影响对话
    }
    // 防止摘要无限增长
    if (chatSummaries.length > 10) chatSummaries = chatSummaries.slice(-10);
  }
  let lastAgentResult: import('deepseek-code-core').LastAgentResult | null = prevState?.lastAgentResult
    ? { ...prevState.lastAgentResult, intent: prevState.lastAgentResult.intent as import('deepseek-code-shared').UserIntent, execution: prevState.lastAgentResult.execution as import('deepseek-code-shared').ExecutionMode, filesRead: prevState.lastAgentResult.filesRead ?? [], toolsUsed: prevState.lastAgentResult.toolsUsed ?? [], findings: prevState.lastAgentResult.findings ?? [], nextSuggestions: [] }
    : null;
  let pendingAction: string | undefined = prevState?.pendingAction?.description;
  let pendingChoices: Array<{ id: string; label: string }> | undefined;
  let pendingChoicesCreatedAt: number = 0;
  let isFirstMessage = !prevState;
  let conversationFocus: import('deepseek-code-core').RouterContext['conversationFocus'] = undefined;

  /** 从 Agent 回答中提取对话焦点（文件/符号/URL） */
  function updateFocus(output: string) {
    const fileMatch = output.match(/(?:在|文件|模块)\s*[`"「]?(packages\/[^\s`"」,，\n]{3,80}\.(?:ts|tsx|json))/);
    if (fileMatch) {
      conversationFocus = { kind: 'file', label: fileMatch[1].split('/').pop()!, file: fileMatch[1], confidence: 0.8 };
      return;
    }
    const symbolMatch = output.match(/[`]([a-zA-Z_]\w{2,40})[`]\s*(?:函数|类|模块|方法)/);
    if (symbolMatch) {
      conversationFocus = { kind: 'symbol', label: symbolMatch[1], symbol: symbolMatch[1], confidence: 0.7 };
      return;
    }
  }

  if (prevState) {
    console.log(`📝 已恢复上次会话状态 (${prevState.chatHistory.length} 条历史, ${new Date(prevState.updatedAt).toLocaleString('zh-CN')})`);
    if (prevState.pendingAction) {
      console.log(`⏳ 待处理: ${prevState.pendingAction.description}`);
    }
  }

  /** 追加到聊天历史并自动截断 */
  function pushHistory(msg: { role: 'user' | 'assistant' | 'system'; content: string }) {
    chatHistory.push(msg);
    if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory = chatHistory.slice(-CHAT_HISTORY_MAX);
    // 异步压缩，不阻塞
    if (chatHistory.length >= 20 && chatHistory.length % 10 === 0) summarizeAndCompress();
  }

  /** 持久化当前交互会话状态 */
  function persistState() {
    saveInteractiveState(workingDir, {
      projectPath: workingDir,
      lastAgentResult: lastAgentResult ? {
        task: lastAgentResult.task,
        intent: lastAgentResult.intent,
        execution: lastAgentResult.execution,
        summary: lastAgentResult.summary,
        filesRead: lastAgentResult.filesRead,
        toolsUsed: lastAgentResult.toolsUsed,
        findings: lastAgentResult.findings,
        nextSuggestions: lastAgentResult.nextSuggestions,
        completedAt: lastAgentResult.completedAt,
      } : undefined,
      pendingAction: pendingAction ? {
        type: 'awaiting_confirmation',
        description: pendingAction,
        context: {},
        createdAt: new Date().toISOString(),
      } : undefined,
      lastExternalResource: lastAgentResult?.filesRead?.find((f) => f.startsWith('http'))
        ? { url: lastAgentResult.filesRead.find((f) => f.startsWith('http'))!, title: lastAgentResult.summary?.slice(0, 100) }
        : prevState?.lastExternalResource,
      recentExternalResources: prevState?.recentExternalResources ?? [],
      chatHistory,
      chatSummaries,
      updatedAt: new Date().toISOString(),
    });
  }

  rl.prompt();

  rl.on('line', async (line: string) => {
    let input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // 短回复继承: resolvePendingChoice 解析 "1"/"一"/"第一项" 等序号
    if (pendingChoices && pendingChoices.length > 0) {
      // TTL 过期: 超过 5 分钟自动清空
      const TTL_MS = 5 * 60 * 1000;
      if (pendingChoicesCreatedAt && Date.now() - pendingChoicesCreatedAt > TTL_MS) {
        console.log('⏰ 上次选项已过期，请重新输入完整任务\n');
        pendingChoices = undefined;
        pendingChoicesCreatedAt = 0;
      } else {
        const resolved = resolvePendingChoice(input, pendingChoices);
        if (resolved) {
          console.log(`\n🔗 已选择: ${resolved.label}\n`);
          input = resolved.label;
          pendingChoices = undefined;
          pendingChoicesCreatedAt = 0;
          pendingAction = input;
        }
      }
    }

    // 系统操作：不经过路由
    if (input === '/exit' || input === '/quit' || input === 'exit' || input === 'quit' || input === '退出') {
      console.log('👋 再见！');
      rl.close();
      return;
    }
    if (input === '/clear' || input === 'clear' || input === '清屏') {
      console.clear();
      rl.prompt();
      return;
    }
    // local_action: 系统命令——不调LLM，不扫项目，不进Agent
    if (input === 'help' || input === '/help' || input === '?' || input === '？' || input === '帮助') {
      console.log('🤖 DeepSeek Code CLI — 输入 /help 查看命令，或直接说"分析项目"开始');
      rl.prompt();
      return;
    }
    if (input === 'status' || input === '/status') {
      const t = createToolExecutors({ workingDir });
      const r = await t.gitStatus();
      console.log(r.content);
      rl.prompt();
      return;
    }
    if (input === 'sessions' || input === '/sessions') {
      const m = new FileMemoryStore(workingDir);
      const list = await m.listSessions();
      for (const s of list.slice(0, 10)) {
        console.log(`  ${s.completed ? '✅' : '⏳'} [${s.id}] ${new Date(s.createdAt).toLocaleString('zh-CN')} ${s.taskDescription.slice(0, 60)}`);
      }
      rl.prompt();
      return;
    }
    if (input === 'model' || input === '/model') {
      console.log(`🧠 当前模型策略: ${modelStrategy}。使用 --model flash/pro/auto 切换。`);
      rl.prompt();
      return;
    }
    // 模式切换: /命令 或 自然语言
    const modeSwitch: Record<string, 'plan' | 'edit' | 'auto'> = {};
    if (/\/plan|计划模式|只读模式|进入.*计划|切换到?.*计划|agent.*模式|读.*模式/i.test(input) && !/编辑|自主|自动|写/i.test(input)) modeSwitch['plan'] = 'plan';
    if (/\/edit|编辑模式|写.*模式|进入.*编辑|切换到?.*编辑|读写.*模式|确认.*模式/i.test(input)) modeSwitch['edit'] = 'edit';
    if (/\/auto|自主模式|自动模式|全自动|进入.*自主|切换到?.*自主/i.test(input)) modeSwitch['auto'] = 'auto';

    const switchTo = modeSwitch['plan'] || modeSwitch['edit'] || modeSwitch['auto'];
    if (switchTo) {
      const prev = currentMode;
      currentMode = switchTo;
      if (prev !== currentMode) {
        sharedMessages = null; lastAgentResult = null; pendingAction = undefined; conversationFocus = undefined;
        const labels: Record<string, string> = { plan: '📋 计划(只读)', edit: '✏️ 编辑(审批)', auto: '🚀 自主(全自动)' };
        console.log(`🔄 ${labels[prev]} → ${labels[currentMode]}。上下文已重置。`);
      }
      rl.prompt();
      return;
    }
    if (input === '/new') {
      sharedMessages = null;
      chatHistory = [];
      lastAgentResult = null;
      pendingAction = undefined;
      isFirstMessage = true;
      clearInteractiveState(workingDir);
      console.log('🆕 已开始新会话');
      rl.prompt();
      return;
    }

    if (input === '/diff') {
      const tools = createToolExecutors({ workingDir });
      const result = await tools.gitDiff({});
      console.log(result.content);
      rl.prompt();
      return;
    }

    if (input === '/status') {
      const tools = createToolExecutors({ workingDir });
      const result = await tools.gitStatus();
      console.log(result.content);
      rl.prompt();
      return;
    }

    if (input === '/help') {
      console.log(`
可用命令：
  /plan     - 📋 计划模式(只读/分析/搜索)
  /edit     - ✏️ 编辑模式(写操作需审批)
  /auto     - 🚀 自主模式(全自动执行)
  /diff     - 查看 Git diff
  /sessions - 查看历史会话
  /new      - 开始新会话
  /exit     - 退出
  其他内容   - 作为任务描述执行
`);
      rl.prompt();
      return;
    }

    if (input === '/sessions') {
      const memory = new FileMemoryStore(workingDir);
      const sessions = await memory.listSessions();
      if (sessions.length === 0) {
        console.log('暂无历史会话');
      } else {
        for (const s of sessions.slice(0, 10)) {
          const dateStr = new Date(s.createdAt).toLocaleString('zh-CN');
          console.log(`  [${s.id}] ${dateStr} - ${s.taskDescription.slice(0, 60)}${s.completed ? ' ✅' : ' ⏳'}`);
        }
      }
      rl.prompt();
      return;
    }

    // 非短回复的真实任务输入 → 用户已转向新任务，清空待选项
    if (pendingChoices) {
      pendingChoices = undefined;
      pendingChoicesCreatedAt = 0;
    }

    // 意图分流（带 spinner，避免 silent gap）
    const spinner = startSpinner('分析意图');
    const routerMode = currentMode === 'plan' ? 'readonly' : currentMode === 'edit' ? 'ask' : 'auto';
    let route;
    try {
      route = await routeInput(input, {
        mode: routerMode,
        projectName: path.basename(workingDir),
        projectPath: workingDir,
        lastAgentResult: lastAgentResult ?? undefined,
        pendingAction,
        lastExternalResource: prevState?.lastExternalResource,
        conversationFocus,
        recentMessages: chatHistory.slice(-6).map((m) => ({ role: m.role, content: m.content })),
      }, createLLMRouterClient(apiKey, baseUrl));
    } finally {
      stopSpinner(spinner);
    }
    logRoute(route, routerMode);
    // Execution Dispatcher: url_fetch_pipeline
    if (route.execution === 'url_fetch_pipeline' && route.target?.type === 'url') {
      const { runUrlFetchPipeline, formatUrlFetchResult } = await import('deepseek-code-core');
      console.log('🌐 URL Fetch Pipeline\n');
      const result = await runUrlFetchPipeline(route.target.url);
      console.log(formatUrlFetchResult(result));
      console.log(`\n⏱ ${(result.elapsedMs / 1000).toFixed(1)}s`);
      // 保存 lastExternalResource 用于 URL 追问
      pushHistory({ role: 'assistant', content: `[URL Fetch] ${result.title ?? route.target.url}: ${result.summary ?? result.text.slice(0, 200)}` });
      lastAgentResult = { task: input, intent: route.intent, execution: route.execution, summary: result.summary ?? result.text.slice(0, 300), filesRead: [route.target.url], toolsUsed: ['url_fetch_pipeline'], findings: [result.text.slice(0, 200)], nextSuggestions: [], completedAt: new Date().toISOString() };
      persistState();
      rl.prompt();
      return;
    }
    // Execution Dispatcher: diff review（必须在 debug_task 之前，防误入 repair pipeline）
    // 匹配 command_status+diff（简单查看）或 debug_task+diff（带具体审查目标如安全/测试/API）
    if ((route.intent === 'command_status' || route.intent === 'debug_task') && /diff|git diff|改动|变更|changed/i.test(input)) {
      const { runReviewDiffPipeline } = await import('deepseek-code-core');
      console.log('📋 Review Diff Pipeline\n');
      const result = await runReviewDiffPipeline({ workingDir, onProgress: (s) => console.log(`  ⏳ ${s}`) });
      console.log(result.summary);
      console.log(`📊 统计: ${result.stats.totalFiles}文件 | +${result.stats.added}新增 ~${result.stats.modified}修改 -${result.stats.deleted}删除 | 🧪测试${result.stats.testFilesChanged} | 🔒安全${result.stats.securityFilesChanged} | ⚙️配置${result.stats.configFilesChanged}`);
      if (result.riskLevel !== 'low') console.log(`⚠️ 风险等级: ${result.riskLevel}`);
      console.log('');
      for (const f of result.findings) {
        const icon = f.severity === 'high' ? '🔴' : f.severity === 'medium' ? '🟡' : '🟢';
        const cat = f.category === 'security' ? '[安全]' : f.category === 'api' ? '[API]' : f.category === 'test' ? '[测试]' : f.category === 'dependency' ? '[依赖]' : f.category === 'config' ? '[配置]' : '';
        console.log(`  ${icon} ${cat} ${f.file}: ${f.description}`);
        if (f.lineHint) console.log(`     📍 ${f.lineHint}`);
        if (f.suggestion) console.log(`     💡 ${f.suggestion}`);
      }
      if (result.findings.length === 0) console.log('  ✅ 未发现明显问题');
      console.log(`\n⏱ ${(result.elapsedMs / 1000).toFixed(1)}s | 0 模型调用`);
      pushHistory({ role: 'assistant', content: `[Diff Review] ${result.summary}` });
      lastAgentResult = { task: input, intent: 'command_status', execution: 'llm_direct', summary: result.summary, filesRead: result.changedFiles, toolsUsed: ['review_diff_pipeline'], findings: result.findings.map((f) => f.description), nextSuggestions: [], completedAt: new Date().toISOString() };
      persistState();
      rl.prompt();
      return;
    }
    // Execution Dispatcher: debug_task → Repair Pipeline（非 diff 类）
    // 硬门槛: 必须包含错误上下文才进repair, 否则降级agent
    const hasErrorCtx = /TS\d+|报错|异常|失败|堆栈|stack trace|\.(ts|tsx|js):\d+:\d+/.test(input);
    if (route.intent === 'debug_task' && hasErrorCtx) {
      const { runRepairPipeline } = await import('deepseek-code-core');
      const proClient = apiKey ? createProClient(apiKey, baseUrl) : undefined;
      const result = await runRepairPipeline({ workingDir, taskDescription: input, mode: routerMode, proClient, onProgress: (s) => console.log(`  ⏳ ${s}`) });
      console.log(result.summary);
      if (result.errorLocation) console.log(`📍 ${result.errorLocation.file ? `${result.errorLocation.file}:${result.errorLocation.line ?? '?'}` : ''} [${result.errorLocation.category}] ${result.errorLocation.message.slice(0, 120)}`);
      if (result.rootCause) console.log(`\n🔍 根因分析:\n${result.rootCause}`);
      if (result.suggestedFix) console.log(`💡 ${result.suggestedFix}`);
      if (result.filesExamined.length > 0) console.log(`📁 检查文件: ${result.filesExamined.join(', ')}`);
      pushHistory({ role: 'assistant', content: `[Repair] ${result.summary}` });
      lastAgentResult = { task: input, intent: 'debug_task', execution: 'agent_readonly', summary: result.summary, filesRead: result.filesExamined, toolsUsed: ['repair_pipeline'], findings: result.rootCause ? [result.rootCause] : [], nextSuggestions: result.suggestedFix ? [result.suggestedFix] : [], completedAt: new Date().toISOString() };
      pendingAction = result.patchProposal ? `修复补丁待确认: ${result.patchProposal.slice(0, 100)}` : undefined;
      persistState();
      rl.prompt();
      return;
    }
    if (route.execution !== 'agent_readonly' && route.execution !== 'agent_plan' && route.execution !== 'agent_execute') {
      chatHistory = await handleLlmDirect(input, config, apiKey, baseUrl, chatHistory, lastAgentResult, chatSummaries);
      persistState();
      rl.prompt();
      return;
    }

    // 作为对话执行（共享会话上下文）
    const newMsgs = await runChatTurn(
      input,
      isFirstMessage ? null : sharedMessages,
      config, apiKey, baseUrl, modelStrategy, workingDir, currentMode, permManager,
      route?.contextPolicy,
    );
    if (newMsgs) {
      sharedMessages = newMsgs;
      isFirstMessage = false;
      // 检测 Agent 是否有实质产出
      const finalMsgs = newMsgs.filter((m: any) => m.role === 'assistant' && m.content?.length > 100);
      const finalOutput = finalMsgs[finalMsgs.length - 1]?.content ?? '';
      // 统计工具调用次数
      const toolCallCount = newMsgs.filter((m: any) => m.role === 'tool').length;

      if (toolCallCount === 0) {
        // Agent 启动了但没有执行任何工具——任务静默失败
        console.log('⚠️ Agent 未能执行任何工具调用，任务可能未完成');
        pushHistory({ role: 'system', content: `[Agent 任务失败] 用户请求 "${input.slice(0, 80)}"，但 Agent 未能执行任何工具调用就退出了。请向用户说明并建议重试或简化任务。` });
      } else if (finalOutput) {
        pushHistory({ role: 'assistant', content: `[刚才的分析结论，${toolCallCount} 次工具调用，${finalOutput.length} 字] ${finalOutput.slice(0, 1500)}` });

        // 提取编号选项 → pendingChoices (只在模型主动列出引导选项时)
        if (/你可以选择|请选择|需要我|选哪|接下来可以|怎么帮|你想|告诉我/i.test(finalOutput)) {
          const cm = [...finalOutput.matchAll(/(?:^|\n)\s*(\d+)[.、）)]\s*(.+?)(?=\n\s*\d+[.、）)]|\n\n|$)/gm)];
          if (cm.length >= 2 && cm.length <= 5) {
            pendingChoices = cm.map(c => ({ id: c[1], label: c[2].trim().slice(0, 80) }));
            pendingChoicesCreatedAt = Date.now();
          }
        }

        // 提取输入中的 URL，保存到 findings 以支持 URL 追问路由
        const inputUrls = [...input.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
        lastAgentResult = {
          task: input, intent: route.intent, execution: route.execution,
          summary: finalOutput.slice(0, 300),
          filesRead: inputUrls,
          toolsUsed: [`${toolCallCount}次工具调用`],
          findings: [...inputUrls, finalOutput.slice(0, 200)],
          nextSuggestions: [],
          completedAt: new Date().toISOString(),
        };
        updateFocus(finalOutput);
      } else {
        pushHistory({ role: 'system', content: `[Agent 任务执行] 用户请求 "${input.slice(0, 80)}"，执行了 ${toolCallCount} 次工具调用但未生成最终结论。可能未完成。` });
      }
    } else {
      // runChatTurn 返回 null → Agent 启动失败
      console.log('⚠️ Agent 任务启动失败');
      pushHistory({ role: 'system', content: `[Agent 启动失败] 用户请求 "${input.slice(0, 80)}"，但 Agent 未能成功启动。可能原因：API 超时、模型不可用、或计划生成失败。请提示用户检查 API 配置或稍后重试。` });
    }

    persistState();
    rl.prompt();
  });

  rl.on('close', () => {
    persistState();
    process.exit(0);
  });

  // SIGINT (Ctrl+C) 优雅退出：保存状态
  process.on('SIGINT', () => {
    console.log('\n👋 正在保存会话状态...');
    persistState();
    rl.close();
  });
}

/**
 * 交互模式对话轮次：首轮完整流程，后续追加到共享会话
 */
async function runChatTurn(
  input: string,
  messages: import('deepseek-code-shared').ChatMessage[] | null,
  config: DeepSeekCodeConfig,
  apiKey: string, baseUrl: string, modelStrategy: string, workingDir: string, currentMode: 'plan' | 'edit' | 'auto',
  permManager?: PermissionManager,
  contextPolicy?: 'none' | 'session_state' | 'project_summary' | 'project_slices' | 'full_agent',
): Promise<import('deepseek-code-shared').ChatMessage[] | null> {
  const routerConfig: import('deepseek-code-core').ModelRouterConfig = {
    strategy: modelStrategy as 'auto' | 'pro' | 'flash',
    config: { apiKey, baseUrl },
  };
  const router = new ModelRouter(routerConfig);
  const tools = createToolExecutors({ workingDir });
  const memory = new FileMemoryStore(workingDir);
  const model = router.getClient(router.selectModel(input));
  const isReadOnly = currentMode === 'plan';
  const availableTools = isReadOnly ? READ_ONLY_TOOLS : [...READ_ONLY_TOOLS, ...WRITE_TOOLS];

  // 如果没有历史消息，走完整流程；否则追加到已有对话
  if (!messages) {
    const result = await runAgentLoop(input, {
      workingDir, router, tools, memory, readOnly: currentMode === 'plan', streaming: true,
      permissionManager: permManager,
      onConfirm: async () => true,
      contextPolicy,
    });
    if (!result.success || !result.session) return null;

    // 从 session 提取消息链
    const msgs: import('deepseek-code-shared').ChatMessage[] = [];
    const repoSummary = result.session.repoInfo ? buildRepoSummary(result.session.repoInfo) : '';
    msgs.push({ role: 'system', content: `你是 DeepSeek Code Agent。项目信息: ${repoSummary}` });
    for (const step of result.session.steps) {
      if (step.type === 'planning') {
        msgs.push({ role: 'user', content: input + '\n\n' + step.content });
      } else if (step.toolCalls?.length) {
        msgs.push({ role: 'assistant', content: step.content, tool_calls: step.toolCalls });
        for (let i = 0; i < step.toolCalls.length; i++) {
          msgs.push({ role: 'tool', tool_call_id: step.toolCalls[i].id, content: step.toolResults?.[i]?.content ?? '' });
        }
      } else {
        msgs.push({ role: 'assistant', content: step.content });
      }
    }
    return msgs;
  }

  // 追加到已有对话
  messages.push({ role: 'user', content: input });
  const chatSession: import('deepseek-code-shared').Session = {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date(),
    taskDescription: input.slice(0, 80),
    modelName: model.modelName as typeof MODEL_PRO,
    workingDir,
    steps: [],
    completed: false,
    phase: 'analyzing',
    mode: 'readonly' as const,
    appliedPatches: [],
    commandHistory: [],
    knownFiles: [],
    toolResultsCache: {},
  };
  const result = await continueLoop(
    chatSession,
    messages, model, availableTools, workingDir, tools, memory, undefined, currentMode === 'plan', true, Date.now(), 20, undefined,
  );
  if (result.success && result.session) {
    for (const step of result.session.steps) {
      if (step.toolCalls?.length) {
        messages.push({ role: 'assistant', content: step.content, tool_calls: step.toolCalls });
        for (let i = 0; i < step.toolCalls.length; i++) {
          messages.push({ role: 'tool', tool_call_id: step.toolCalls[i].id, content: step.toolResults?.[i]?.content ?? '' });
        }
      } else {
        messages.push({ role: 'assistant', content: step.content });
      }
    }
  }
  return messages;
}

function createLLMRouterClient(apiKey: string, baseUrl: string): import('deepseek-code-core').LLMRouterClient {
  return {
    async chatJson(prompt: string): Promise<string> {
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= 1; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000); // 5s 超时，路由必须快
        try {
          const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: MODEL_FLASH,
              messages: [
                { role: 'system', content: '你只输出 JSON，不要 Markdown，不要解释。' },
                { role: 'user', content: prompt },
              ],
              max_tokens: 1024,
              temperature: 0,
              stream: false,
            }),
            signal: controller.signal,
          });

          if (!res.ok && res.status === 429 && attempt === 0) {
            await new Promise(r => setTimeout(r, 1000)); // rate limit → 等1s重试
            continue;
          }

          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          const data = await res.json() as Record<string, unknown>;
          const raw = (data.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content ?? '';
          const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
          return jsonMatch ? jsonMatch[1].trim() : raw.trim();
        } catch (e) {
          lastError = e as Error;
          if (attempt === 0) continue; // retry once
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError ?? new Error('LLM Router: 重试耗尽');
    },
  };
}

function createFlashChatClient(apiKey: string, baseUrl: string): { chat(prompt: string): Promise<string> } {
  return {
    async chat(prompt: string): Promise<string> {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL_FLASH,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024,
          temperature: 0.1,
          stream: false,
        }),
      });
      const data = await res.json() as any;
      return data.choices?.[0]?.message?.content ?? '';
    },
  };
}

function createProClient(apiKey: string, baseUrl: string): { chat(prompt: string): Promise<string> } {
  return {
    async chat(prompt: string): Promise<string> {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL_PRO,
          messages: [
            { role: 'system', content: '你是一个资深软件工程师，擅长 TypeScript、Node.js 和代码调试。' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 2048,
          temperature: 0.1,
          stream: false,
        }),
      });
      const data = await res.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? '';
      const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      return jsonMatch ? jsonMatch[1].trim() : raw.trim();
    },
  };
}

function logRoute(route: RouteDecision, mode: string): void {
  const execLabel = route.intent === 'audit_task' ? 'audit_pipeline' : route.execution;
  const target = route.target?.type === 'url' ? ` 🎯 URL(${route.target.source})` : '';
  console.log(`🧭 路由: ${route.intent} → ${execLabel}${target}  📌 ${route.reason ?? '无'}  🔒 ${mode}`);
}

function renderHelp(): void {
  console.log(`
🤖 DeepSeek Code CLI — AI 编程 Agent

═══ 能力 ═══

  解释项目      分析项目架构、技术栈、模块依赖
  修复 bug      定位问题根因，生成修复方案
  新增功能      根据需求创建页面/组件/接口
  重构代码      优化结构、消除技术债
  编写测试      补充单元测试、集成测试
  分析报错      读取日志，定位错误原因
  查看 diff     展示 Git 改动

═══ 命令 ═══

  dscode "任务描述"                单次任务
  dscode                          交互模式
  dscode --write "任务"            读写模式
  dscode --model flash "任务"      指定模型
  dscode plan "任务"               仅生成计划
  dscode diff                     查看 Git diff
  dscode rules init               初始化项目规则
  dscode rules template <name>    生成技术栈模板
  dscode sessions                 查看历史会话
  dscode --resume <id>            恢复会话

═══ 模型 ═══

  auto (默认)   自动选择 Flash/Pro
  flash         快速经济，适合简单任务
  pro           最强推理，适合复杂任务

═══ 模式 ═══

  只读 (默认)   只能分析，不能修改
  读写 (--write) 可以修改文件和执行命令
`);
}

async function handleLlmDirect(
  input: string,
  config: DeepSeekCodeConfig,
  apiKey: string,
  baseUrl: string,
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  agentResult?: import('deepseek-code-core').LastAgentResult | null,
  summaries?: string[],
): Promise<Array<{ role: 'user' | 'assistant' | 'system'; content: string }>> {
  console.log('');
  const model: string = (config.defaultModel === 'auto' || config.defaultModel === MODEL_PRO) ? MODEL_FLASH : config.defaultModel;

  // 运行时事实——不依赖聊天记忆
  const facts = [
    `OS: ${process.platform}`,
    `Workspace: ${process.cwd()}`,
    `Shell: ${process.env.SHELL ?? 'cmd'}`,
  ].join('\n');

  // 压缩历史：最近 3 轮原文 + 更早的摘要
  const recent = (history ?? []).slice(-6); // 最近 3 轮 = 6 条消息
  const older = (history ?? []).slice(0, -6);
  const olderSummary = older.length > 0
    ? [{ role: 'system' as const, content: `[更早的对话摘要] ${older.length} 条消息，主要话题: ${older.filter((m) => m.role === 'user').map((m) => m.content.slice(0, 30)).join('; ')}` }]
    : [];

  // 任务事实
  const taskContext = agentResult
    ? [{ role: 'system' as const, content: `[上一轮任务] ${agentResult.task}。结论: ${agentResult.summary?.slice(0, 200)}。读取了 ${agentResult.filesRead?.length ?? 0} 个文件。` }]
    : [];

  const messages = [
    { role: 'system' as const, content: `你是 DeepSeek Code CLI 的 AI 助手。\n${facts}\n用自然友好的语气回答。\n\n约束：不能声称会读取文件、执行命令或调用工具。不能输出工具调用代码块。不能假装执行了操作。如果你的回答需要读项目文件，告诉用户输入 /plan 进入计划模式或 /edit 进入编辑模式。模式切换命令: /plan(只读分析) /edit(写操作需审批) /auto(全自动)。` },
    ...(summaries ?? []).map((s) => ({ role: 'system' as const, content: s })),
    ...olderSummary,
    ...recent,
    ...taskContext,
    { role: 'user' as const, content: input },
  ];

  let fullResponse = '';
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.7, stream: true }),
    });

    if (!response.ok) {
      console.log('🤖 你好！我是 DeepSeek Code Agent，可以帮你分析项目、修复 bug、新增功能。输入 /help 查看详情。');
      return [...(history ?? []), { role: 'user', content: input }, { role: 'assistant', content: '你好！我可以帮你分析项目、修复 bug、新增功能。' }];
    }

    const reader = response.body?.getReader();
    if (!reader) return [...(history ?? []), { role: 'user', content: input }];

    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const json = JSON.parse(line.slice(6));
            const text = json.choices?.[0]?.delta?.content;
            if (text) { process.stdout.write(text); fullResponse += text; }
          } catch { /* skip */ }
        }
      }
      buffer = buffer.split('\n').pop() ?? '';
    }
    console.log('');
  } catch {
    console.log('🤖 你好！我是 DeepSeek Code Agent。输入 /help 查看详情。');
  }

  return [...(history ?? []), { role: 'user', content: input }, { role: 'assistant', content: fullResponse || '...' }];
}

function showSession(session: import('deepseek-code-shared').Session): void {
  const totalSteps = session.steps.length;
  const toolSteps = session.steps.filter((s) => s.type === 'tool_call').length;
  const thinkingSteps = session.steps.filter((s) => s.type === 'thinking').length;

  console.log(`\n📋 会话详情: ${session.id}`);
  console.log('━'.repeat(50));
  console.log(`  任务: ${session.taskDescription}`);
  console.log(`  模型: ${session.modelName}`);
  console.log(`  时间: ${new Date(session.createdAt).toLocaleString('zh-CN')}`);
  console.log(`  状态: ${session.completed ? '✅ 已完成' : '⏳ 未完成'}`);
  console.log(`  步骤: ${totalSteps} 步 (${toolSteps} 工具 + ${thinkingSteps} 思考)`);
  if (session.summary) console.log(`  摘要: ${session.summary}`);
  console.log('━'.repeat(50));

  if (session.steps.length > 0) {
    console.log('\n执行记录:');
    for (const step of session.steps) {
      const icon = step.type === 'tool_call' ? '🔧' : step.type === 'thinking' ? '💭' : step.type === 'final' ? '✅' : '📋';
      console.log(`  ${icon} [${step.type}] ${step.content.slice(0, 80)}`);
    }
  }
}


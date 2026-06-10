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
import { ensureConfig, loadConfig, CONFIG_PATH } from './config.js';
import { getTemplates, generateAgentsMdTemplate } from './templates.js';

// 在任何命令执行前自动确保配置存在
ensureConfig();

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
  .option('-r, --read-only', '只读模式（不修改文件，默认开启）', true)
  .option('--write', '启用写模式（可以修改文件）', false)
  .option('--dry-run', '仅生成计划，不执行', false)
  .option('-d, --dir <dir>', '指定项目目录', process.cwd())
  .option('--resume <session-id>', '恢复指定会话')
  .action(async (task: string | undefined, options: Record<string, string | boolean>) => {
    const config = loadConfig();

    // 合并选项
    const apiKey = (options.apiKey as string) ?? config.apiKey;
    const baseUrl = (options.baseUrl as string) ?? config.baseUrl ?? 'https://api.deepseek.com';
    const modelStrategy = (options.model as string) ?? 'auto';
    const readOnly = !(options.write as boolean);
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
      await interactiveMode(config, apiKey, baseUrl, modelStrategy, workingDir, readOnly);
      return;
    }

    // 意图分流：Hybrid Router
    if (task && !resumeSessionId) {
      const currentMode = readOnly ? 'readonly' as const : 'ask' as const;
      const route = await routeInput(task, {
        mode: currentMode,
        projectName: path.basename(workingDir),
        projectPath: workingDir,
      }, createLLMRouterClient(apiKey, baseUrl));
      logRoute(route, currentMode);
      // audit_task 走 Agent 审查（audit_pipeline 仅用于 dscode audit 命令）
      // Execution Dispatcher: debug_task → Repair Pipeline
      if (route.intent === 'debug_task') {
        const { runRepairPipeline } = await import('deepseek-code-core');
        console.log('🔧 Repair Pipeline\n');
        const proClient = apiKey ? createProClient(apiKey, baseUrl) : undefined;
        const result = await runRepairPipeline({ workingDir, taskDescription: task, mode: currentMode, proClient, onProgress: (s) => console.log(`  ⏳ ${s}`) });
        console.log(result.summary);
        if (result.errorLocation) console.log(`📍 ${result.errorLocation.file ? `${result.errorLocation.file}:${result.errorLocation.line ?? '?'}` : ''} [${result.errorLocation.category}] ${result.errorLocation.message.slice(0, 120)}`);
        if (result.rootCause) console.log(`\n🔍 根因分析:\n${result.rootCause}`);
        if (result.suggestedFix) console.log(`💡 ${result.suggestedFix}`);
        if (result.filesExamined.length > 0) console.log(`📁 检查文件: ${result.filesExamined.join(', ')}`);
        console.log(`\n⏱ ${(result.elapsedMs / 1000).toFixed(1)}s`);
        return;
      }
      // Execution Dispatcher: diff review
      if (route.intent === 'command_status' && task?.includes('diff')) {
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
    await runTask(task || '恢复会话', config, apiKey, baseUrl, modelStrategy, workingDir, readOnly, dryRun, resumeSessionId);
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
      true,
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
      true,
      true,
    );
  });

// Git Diff 查看
program
  .command('diff')
  .description('查看当前 Git 改动')
  .action(async () => {
    const { createToolExecutors } = await import('deepseek-code-core');
    const tools = createToolExecutors({ workingDir: process.cwd() });
    const result = await tools.gitDiff({});
    console.log(result.content);
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
  .description('系统评测 (target: router)')
  .option('--suite <name>', '指定评测套件')
  .option('--format <fmt>', '输出格式: json, markdown', 'markdown')
  .option('--live', '使用真实 LLM Router（默认 mock）')
  .action(async (target: string, options) => {
    if (target !== 'router') {
      console.log('当前只支持 eval router');
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
  .command('context [action]')
  .description('显示上下文缓存状态 (context / context stats)')
  .action(async () => {
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
  .command('sessions [action]')
  .description('管理历史会话 (list / show <id> / resume <id>)')
  .action(async (action: string | undefined) => {
    const memory = new FileMemoryStore(process.cwd());
    if (!action || action === 'list') {
      const sessions = await memory.listSessions();
      if (sessions.length === 0) {
        console.log('📝 暂无历史会话');
        return;
      }
      console.log(`📝 共 ${sessions.length} 个会话:\n`);
      for (const s of sessions.slice(0, 20)) {
        const date = new Date(s.createdAt).toLocaleString('zh-CN');
        const icon = s.completed ? '✅' : '⏳';
        console.log(`  ${icon} [${s.id}]`);
        console.log(`     ${date}  ${s.taskDescription.slice(0, 60)}`);
        console.log('');
      }
    } else if (action === 'show') {
      console.log('用法: dscode sessions show <session-id>');
    } else if (action === 'resume') {
      console.log('用法: dscode sessions resume <session-id>');
    } else {
      // 可能是 show <id> 或 resume <id>，但 commander 会把第一个参数当 action
      // 这里做不了，需要子命令嵌套
      const id = action;
      const session = await memory.loadSession(id);
      if (!session) {
        console.log(`会话 ${id} 不存在`);
        return;
      }
      showSession(session);
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
  readOnly: boolean,
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
  console.log(`🔒 模式: ${readOnly ? '只读分析' : '读写'}`);
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

      // 只读模式：拒绝所有写操作
      if (readOnly) {
        console.log(`\n🔒 只读模式，已拒绝: ${req.type} → ${req.target}`);
        return 'deny';
      }

      // 读写模式：交互确认
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
    readOnly,
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
  readOnly: boolean,
) {
  console.log(`
╔══════════════════════════════════════╗
║       🤖 DeepSeek Code CLI          ║
║   面向中文开发者的 AI 编程 Agent      ║
╚══════════════════════════════════════╝
`);
  console.log(`📁 当前项目: ${path.basename(workingDir)}`);
  console.log(`🧠 模型策略: ${modelStrategy}`);
  console.log(`🔒 模式: ${readOnly ? '只读分析' : '读写'}`);
  console.log('');
  console.log('输入任务描述开始，或输入以下命令：');
  console.log('  /help     - 帮助');
  console.log('  /diff     - 查看 Git diff');
  console.log('  /status   - 查看 Git 状态');
  console.log('  /sessions - 查看历史会话');
  console.log('  /write    - 切换读写模式');
  console.log('  /new      - 开始新会话');
  console.log('  /exit     - 退出');
  console.log('');

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
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
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
    if (input === '/write' || input === 'write') {
      readOnly = !readOnly;
      sharedMessages = null; // 切换模式清上下文
      console.log(`🔓 已切换为 ${readOnly ? '只读' : '读写'} 模式。${readOnly ? '写操作将被拦截。' : '我可以创建/修改文件了。'}`);
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
  /help     - 显示此帮助
  /write    - 切换读写模式 (默认只读)
  /exit     - 退出
  /diff     - 查看 Git diff
  /status   - 查看 Git 状态
  /sessions - 查看历史会话
  /new      - 开始新会话
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

    // 自动检测写操作需求
    const writeKeywords = /创建|写入|修改.*文件|删除.*文件|生成.*文件|新建.*文件|重构|安装.*依赖/i;
    if (readOnly && writeKeywords.test(input)) {
      console.log(`\n⚠️  这个任务可能需要写文件，当前为只读模式`);
      console.log('   输入 y 切换为读写模式执行，或直接回车保持只读分析：');
      const answer = await new Promise<string>((resolve) => rl.question('   > ', resolve));
      if (answer.trim().toLowerCase() === 'y') {
        readOnly = false;
        sharedMessages = null;
        console.log('🔓 已切换为读写模式\n');
      }
    }

    // 意图分流
    const route = await routeInput(input, {
      mode: readOnly ? 'readonly' : 'ask',
      projectName: path.basename(workingDir),
      projectPath: workingDir,
      lastAgentResult: lastAgentResult ?? undefined,
      pendingAction,
      lastExternalResource: prevState?.lastExternalResource,
      conversationFocus,
      recentMessages: chatHistory.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    }, createLLMRouterClient(apiKey, baseUrl));
    logRoute(route, readOnly ? 'readonly' : 'ask');
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
    // audit_task 走 Agent 审查
    // Execution Dispatcher: debug_task → Repair Pipeline
    if (route.intent === 'debug_task') {
      const { runRepairPipeline } = await import('deepseek-code-core');
      const proClient = apiKey ? createProClient(apiKey, baseUrl) : undefined;
      const result = await runRepairPipeline({ workingDir, taskDescription: input, mode: readOnly ? 'readonly' : 'ask', proClient, onProgress: (s) => console.log(`  ⏳ ${s}`) });
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
    // Execution Dispatcher: diff review
    if (route.intent === 'command_status' && input.includes('diff')) {
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
      config, apiKey, baseUrl, modelStrategy, workingDir, readOnly,
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
        // 提取输入中的 URL，保存到 findings 以支持 URL 追问路由
        const inputUrls = [...input.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
        lastAgentResult = {
          task: input, intent: 'code_task', execution: 'agent_readonly',
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
  apiKey: string, baseUrl: string, modelStrategy: string, workingDir: string, readOnly: boolean,
): Promise<import('deepseek-code-shared').ChatMessage[] | null> {
  const routerConfig: import('deepseek-code-core').ModelRouterConfig = {
    strategy: modelStrategy as 'auto' | 'pro' | 'flash',
    config: { apiKey, baseUrl },
  };
  const router = new ModelRouter(routerConfig);
  const tools = createToolExecutors({ workingDir });
  const memory = new FileMemoryStore(workingDir);
  const model = router.getClient(router.selectModel(input));
  const availableTools = readOnly ? READ_ONLY_TOOLS : [...READ_ONLY_TOOLS, ...WRITE_TOOLS];

  // 如果没有历史消息，走完整流程；否则追加到已有对话
  if (!messages) {
    const result = await runAgentLoop(input, {
      workingDir, router, tools, memory, readOnly, streaming: true,
      onConfirm: async () => true,
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
    messages, model, availableTools, workingDir, tools, memory, undefined, readOnly, true, Date.now(), 20, undefined,
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
    { role: 'system' as const, content: `你是 DeepSeek Code CLI 的 AI 助手。\n${facts}\n用自然友好的语气回答。\n\n约束：不能声称会读取文件、执行命令或调用工具。不能输出 \`\`\`tool 代码块。不能假装你执行了什么操作。如果你需要读取项目文件，请让用户确认是否进入 Agent 模式。` },
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


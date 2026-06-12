// ============================================================
// dscode workflow — Workflow Runner v0 命令
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import {
  WorkflowEngine,
  validateWorkflow,
  loadWorkflowDefinition,
  listWorkflowDefinitions,
  saveWorkflowDefinition,
  listWorkflowRuns,
  loadWorkflowRun,
  BUILTIN_WORKFLOWS,
  createToolExecutors,
  executeTool,
} from 'deepseek-code-core';
import type { ToolExecutor, PipelineExecutor } from 'deepseek-code-core';
import type { WorkflowDefinition, WorkflowExecutionContext, WorkflowBudget } from 'deepseek-code-shared';
import { DEFAULT_WORKFLOW_BUDGET } from 'deepseek-code-shared';

/**
 * 将 dscode 的 createToolExecutors 适配为 ToolExecutor 签名
 */
function createToolExecutor(workingDir: string): ToolExecutor {
  const executors = createToolExecutors({ workingDir });
  return async (toolName, params, _context) => {
    try {
      const result = await executeTool(toolName, params, executors);
      // 返回完整的 ToolExecutionResult（含 content + metadata），
      // 让模板变量能访问结构化字段（如 .metadata.hasUncommittedChanges）
      return {
        success: result.success !== false,
        output: result,
        error: result.error,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  };
}

/**
 * Pipeline 执行器（v0：简单适配现有管线）
 */
function createPipelineExecutor(workingDir: string): PipelineExecutor {
  const toolExec = createToolExecutor(workingDir);
  return async (pipelineName, params, _context) => {
    try {
      // 现有管线通过 tool executor 间接调用
      switch (pipelineName) {
        case 'review_diff':
        case 'review-diff': {
          const gitDiff = await toolExec('git_diff', {}, _context);
          if (!gitDiff.success) return { success: false, error: '无法获取 git diff' };
          // review_diff 是零模型审查，直接输出结果
          // 这里调用现有的 review-diff pipeline
          const { runReviewDiffPipeline } = await import('deepseek-code-core');
          const report = await runReviewDiffPipeline(params as any);
          return { success: true, output: report };
        }
        case 'audit': {
          const { runAuditPipeline } = await import('deepseek-code-core');
          const report = await runAuditPipeline({ ...params, workingDir } as any);
          return { success: true, output: report };
        }
        case 'repair': {
          const { runRepairPipeline } = await import('deepseek-code-core');
          const result = await runRepairPipeline({ ...params, workingDir } as any);
          return { success: true, output: result };
        }
        case 'url_fetch':
        case 'url-fetch': {
          const { runUrlFetchPipeline } = await import('deepseek-code-core');
          const result = await runUrlFetchPipeline({ ...params, workingDir } as any);
          return { success: true, output: result };
        }
        default:
          return { success: false, error: `未知管线: ${pipelineName}` };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  };
}

/**
 * 列出所有可用工作流（内置 + 已保存）
 */
function listAllWorkflows(workspaceRoot: string): WorkflowDefinition[] {
  const saved = listWorkflowDefinitions(workspaceRoot);
  const savedIds = new Set(saved.map(d => d.id));
  // 内置工作流优先，同名不覆盖
  const builtins = BUILTIN_WORKFLOWS.filter(b => !savedIds.has(b.id));
  return [...builtins, ...saved];
}

/**
 * 按 ID 查找工作流
 */
function findWorkflow(workspaceRoot: string, workflowId: string): WorkflowDefinition | null {
  // 先查内置
  const builtin = BUILTIN_WORKFLOWS.find(b => b.id === workflowId);
  if (builtin) return builtin;
  // 再查文件
  return loadWorkflowDefinition(workspaceRoot, workflowId);
}

/**
 * 构建执行上下文
 */
function buildContext(workspaceRoot: string, mode: 'readonly' | 'ask' | 'auto'): WorkflowExecutionContext {
  return {
    mode,
    workspaceRoot,
    sessionId: `wf_${Date.now()}`,
    allowedTools: mode === 'readonly'
      ? ['read_file', 'read_file_range', 'read_file_batch', 'search_code', 'list_files', 'glob', 'git_status', 'git_diff', 'git_log', 'git_show', 'web_search', 'web_fetch', 'read_json_path', 'list_scripts', 'file_exists', 'find_references', 'detect_cross_platform']
      : [],
    budgets: { ...DEFAULT_WORKFLOW_BUDGET },
    traceId: `trace_${Date.now()}`,
  };
}

// ============================================================
// 命令处理函数（由 index.ts 注册）
// ============================================================

/** dscode workflow init — 生成工作流模板 */
export async function cmdWorkflowInit(workspaceRoot: string): Promise<void> {
  const template: WorkflowDefinition = {
    schemaVersion: '0.1',
    id: 'my-workflow',
    name: '我的工作流',
    description: '请修改此模板',
    nodes: [
      { id: 'begin', type: 'BEGIN' },
      { id: 'step1', type: 'TOOL', tool: 'list_files', name: '第一步', params: {} },
      { id: 'end', type: 'END', name: '完成' },
    ],
    edges: [
      { from: 'begin', to: 'step1' },
      { from: 'step1', to: 'end' },
    ],
  };

  const targetPath = path.join(workspaceRoot, 'workflow.json');
  if (fs.existsSync(targetPath)) {
    console.log('⚠️  workflow.json 已存在。');
    console.log('💡 用法: dscode workflow validate workflow.json');
    return;
  }
  fs.writeFileSync(targetPath, JSON.stringify(template, null, 2), 'utf-8');
  console.log('✅ 已生成 workflow.json');
  console.log('');
  console.log('📋 下一步:');
  console.log('   1. 编辑 workflow.json');
  console.log('   2. dscode workflow validate workflow.json');
  console.log('   3. dscode workflow run workflow.json');
  console.log('');
  console.log('💡 也可以查看内置工作流: dscode workflow list');
}

/** dscode workflow validate <file> */
export async function cmdWorkflowValidate(filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    console.log(`❌ 文件不存在: ${filePath}`);
    process.exit(1);
  }

  let def: WorkflowDefinition;
  try {
    def = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    console.log('❌ JSON 解析失败，请检查格式');
    process.exit(1);
  }

  const result = validateWorkflow(def);
  if (result.valid) {
    console.log('✅ 工作流校验通过');
    console.log(`   ${def.nodes.length} 个节点, ${def.edges.length} 条边`);
  } else {
    console.log(`❌ 校验失败 (${result.errors.length} 个错误):`);
    for (const err of result.errors) {
      console.log(`   - ${err}`);
    }
    process.exit(1);
  }
}

/** dscode workflow run <file> */
export async function cmdWorkflowRun(
  filePathOrId: string,
  workspaceRoot: string,
  mode: 'readonly' | 'ask' | 'auto' = 'readonly',
  inputJson?: string,
): Promise<void> {
  // 先尝试作为文件路径
  let def: WorkflowDefinition | null = null;
  if (fs.existsSync(filePathOrId)) {
    try {
      def = JSON.parse(fs.readFileSync(filePathOrId, 'utf-8'));
    } catch {
      console.log('❌ JSON 解析失败');
      process.exit(1);
    }
  } else {
    // 作为工作流 ID 查找
    def = findWorkflow(workspaceRoot, filePathOrId);
    if (!def) {
      console.log(`❌ 工作流不存在: ${filePathOrId}`);
      console.log('💡 运行 dscode workflow list 查看可用工作流');
      process.exit(1);
    }
  }

  // 兜底：如果上面 process.exit 都没触发但 def 仍为 null
  if (!def) {
    console.log(`❌ 工作流不存在: ${filePathOrId}`);
    process.exit(1);
  }

  const input: Record<string, unknown> = inputJson ? JSON.parse(inputJson) : {};

  console.log(`🚀 执行工作流: ${def.name} (${def.id})`);
  console.log(`   节点: ${def.nodes.length} | 边: ${def.edges.length}`);
  console.log('');

  const context = buildContext(workspaceRoot, mode);
  const engine = new WorkflowEngine(
    createToolExecutor(workspaceRoot),
    createPipelineExecutor(workspaceRoot),
  );

  const startTime = Date.now();
  const run = await engine.execute(def, input, context);
  const elapsed = Date.now() - startTime;

  // 打印执行过程
  for (const node of def.nodes) {
    const result = run.nodeResults[node.id];
    if (!result) continue;
    const icon = result.status === 'success' ? '✅' : result.status === 'failed' ? '❌' : result.status === 'blocked' ? '🚫' : result.status === 'skipped' ? '⏭️' : '⏳';
    const name = node.name || node.id;
    const type = node.type;
    console.log(`  ${icon} [${type}] ${name} (${result.status})`);
    if (result.error) {
      console.log(`     错误: ${result.error.message}`);
    }
  }

  console.log('');
  if (run.status === 'completed') {
    console.log(`✅ 工作流完成 (${elapsed}ms)`);
    // 打印 END 节点的输出
    const endNode = def.nodes.find(n => n.type === 'END');
    if (endNode) {
      const endResult = run.nodeResults[endNode.id];
      if (endResult?.output) {
        console.log('\n📤 输出:');
        console.log(JSON.stringify(endResult.output, null, 2));
      }
    }
  } else if (run.status === 'failed') {
    console.log(`❌ 工作流失败 (${elapsed}ms)`);
    for (const err of run.errors) {
      console.log(`   ${err}`);
    }
  } else if (run.status === 'blocked') {
    console.log(`🚫 工作流被阻断: ${run.stopReason || '未知原因'}`);
  }

  console.log(`\n💾 运行记录: ${run.id}`);
  console.log(`   查看: dscode workflow show ${run.id}`);
}

/** dscode workflow list */
export async function cmdWorkflowList(workspaceRoot: string): Promise<void> {
  const defs = listAllWorkflows(workspaceRoot);
  if (defs.length === 0) {
    console.log('📝 暂无工作流');
    console.log('💡 运行 dscode workflow init 生成模板');
    return;
  }

  console.log(`📝 共 ${defs.length} 个工作流:\n`);
  for (const def of defs) {
    const isBuiltin = BUILTIN_WORKFLOWS.some(b => b.id === def.id);
    const tag = isBuiltin ? '📦内置' : '💾已保存';
    console.log(`  ${tag} [${def.id}] ${def.name}`);
    if (def.description) console.log(`      ${def.description}`);
    console.log(`      ${def.nodes.length} 节点 | ${def.edges.length} 边`);
    console.log('');
  }

  console.log('💡 执行: dscode workflow run <id>');
}

/** dscode workflow runs */
export async function cmdWorkflowRuns(workspaceRoot: string): Promise<void> {
  const runs = listWorkflowRuns(workspaceRoot);
  if (runs.length === 0) {
    console.log('📝 暂无运行记录');
    return;
  }

  console.log(`📝 共 ${runs.length} 条运行记录:\n`);
  for (const run of runs.slice(0, 20)) {
    const icon = run.status === 'completed' ? '✅' : run.status === 'failed' ? '❌' : '⏳';
    const date = new Date(run.createdAt).toLocaleString('zh-CN');
    console.log(`  ${icon} [${run.id}] ${run.workflowId}`);
    console.log(`     ${date} | ${run.status} | ${Object.keys(run.nodeResults).length} 节点`);
    if (run.stopReason) console.log(`     原因: ${run.stopReason}`);
    console.log('');
  }
}

/** dscode workflow show <runId> */
export async function cmdWorkflowShow(workspaceRoot: string, runId: string): Promise<void> {
  const run = loadWorkflowRun(workspaceRoot, runId);
  if (!run) {
    // 尝试前缀匹配
    const runs = listWorkflowRuns(workspaceRoot);
    const matched = runs.filter(r => r.id.startsWith(runId));
    if (matched.length === 1) {
      return cmdWorkflowShow(workspaceRoot, matched[0].id);
    }
    if (matched.length > 1) {
      console.log(`❌ ${runId} 匹配到多个记录，请提供完整 ID`);
      return;
    }
    console.log(`❌ 运行记录不存在: ${runId}`);
    return;
  }

  console.log(`📋 运行记录: ${run.id}`);
  console.log(`   工作流: ${run.workflowId}`);
  console.log(`   状态: ${run.status}`);
  console.log(`   开始: ${run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '-'}`);
  console.log(`   结束: ${run.endedAt ? new Date(run.endedAt).toLocaleString('zh-CN') : '-'}`);
  if (run.stopReason) console.log(`   原因: ${run.stopReason}`);
  console.log(`   工具调用: ${run.totalToolCalls}`);
  console.log('');

  console.log('📊 节点执行:');
  for (const [nodeId, result] of Object.entries(run.nodeResults)) {
    const icon = result.status === 'success' ? '✅' : result.status === 'failed' ? '❌' : result.status === 'blocked' ? '🚫' : result.status === 'skipped' ? '⏭️' : '⏳';
    console.log(`  ${icon} [${result.type}] ${nodeId} → ${result.status}`);
    if (result.error) console.log(`     错误: ${result.error.message}`);
    if (result.toolCalls) console.log(`     工具调用: ${result.toolCalls}`);
  }

  if (run.errors.length > 0) {
    console.log(`\n⚠️  错误 (${run.errors.length}):`);
    for (const err of run.errors) console.log(`   - ${err}`);
  }
}

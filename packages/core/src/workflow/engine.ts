// ============================================================
// Workflow Engine v0 — 编排 dscode 已有 pipeline / tool
// 不做通用平台，服务 review-diff / repair / code-review
// ============================================================

import { randomUUID } from 'crypto';
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowEdge,
  WorkflowRun,
  WorkflowNodeResult,
  WorkflowExecutionContext,
  WorkflowBudget,
  RunStatus,
} from 'deepseek-code-shared';
import { DEFAULT_WORKFLOW_BUDGET } from 'deepseek-code-shared';
import { validateWorkflow } from './validator.js';
import { resolveTemplate, resolveObject } from './resolver.js';
import { evaluateExpression } from './expressions.js';
import { saveWorkflowRun } from './storage.js';

// ---- 依赖注入：工具 / 管线执行器 ----

/** 工具执行签名：接收工具名+参数+上下文，返回结果 */
export type ToolExecutor = (
  toolName: string,
  params: Record<string, unknown>,
  context: WorkflowExecutionContext,
) => Promise<{ success: boolean; output?: unknown; error?: string }>;

/** 管线执行签名 */
export type PipelineExecutor = (
  pipelineName: string,
  params: Record<string, unknown>,
  context: WorkflowExecutionContext,
) => Promise<{ success: boolean; output?: unknown; error?: string }>;

// ---- 引擎 ----

export class WorkflowEngine {
  private toolExecutor: ToolExecutor;
  private pipelineExecutor: PipelineExecutor;

  constructor(toolExecutor: ToolExecutor, pipelineExecutor: PipelineExecutor) {
    this.toolExecutor = toolExecutor;
    this.pipelineExecutor = pipelineExecutor;
  }

  /**
   * 执行工作流
   *
   * @param def 工作流定义
   * @param input 输入参数
   * @param context 执行上下文（权限边界）
   * @returns 运行记录
   */
  async execute(
    def: WorkflowDefinition,
    input: Record<string, unknown>,
    context: WorkflowExecutionContext,
  ): Promise<WorkflowRun> {
    // 1. 校验
    const validation = validateWorkflow(def);
    if (!validation.valid) {
      return createFailedRun(def, input, `校验失败: ${validation.errors.join('; ')}`);
    }

    // 2. 合并预算
    const budgets: WorkflowBudget = {
      maxNodes: def.budgets?.maxNodes ?? context.budgets.maxNodes ?? DEFAULT_WORKFLOW_BUDGET.maxNodes,
      maxToolCalls: def.budgets?.maxToolCalls ?? context.budgets.maxToolCalls ?? DEFAULT_WORKFLOW_BUDGET.maxToolCalls,
      timeoutMs: def.budgets?.timeoutMs ?? context.budgets.timeoutMs ?? DEFAULT_WORKFLOW_BUDGET.timeoutMs,
    };

    // 3. 初始化运行记录
    const run: WorkflowRun = {
      id: `run_${randomUUID().slice(0, 12)}`,
      workflowId: def.id,
      status: 'running',
      input,
      nodeResults: {},
      currentNodeIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      totalToolCalls: 0,
      errors: [],
    };

    // 初始化所有节点状态
    for (const node of def.nodes) {
      run.nodeResults[node.id] = {
        nodeId: node.id,
        type: node.type,
        status: 'pending',
        startedAt: '',
        endedAt: '',
      };
    }

    // 4. 构建邻接表
    const nodeMap = new Map(def.nodes.map(n => [n.id, n]));
    const adjacency = buildAdjacency(def.edges);

    // 5. 找 BEGIN 节点
    const beginNode = def.nodes.find(n => n.type === 'BEGIN');
    if (!beginNode) {
      run.status = 'failed';
      run.errors.push('缺少 BEGIN 节点');
      return run;
    }

    // 6. 执行
    const startTime = Date.now();
    try {
      await this.executeFrom(beginNode.id, nodeMap, adjacency, def, run, input, context, budgets, startTime);
      // 执行完成后检查是否所有可达节点已完成
      if (run.status === 'running') {
        run.status = 'completed';
      }
    } catch (err) {
      if (run.status === 'running') {
        run.status = 'failed';
        run.stopReason = (err as Error).message;
        run.errors.push((err as Error).message);
      }
    } finally {
      run.updatedAt = new Date().toISOString();
      run.endedAt = new Date().toISOString();
      saveWorkflowRun(context.workspaceRoot, run);
    }

    return run;
  }

  /**
   * 从指定节点执行（递归），按边遍历下游
   */
  private async executeFrom(
    nodeId: string,
    nodeMap: Map<string, WorkflowNode>,
    adjacency: Map<string, WorkflowEdge[]>,
    def: WorkflowDefinition,
    run: WorkflowRun,
    input: Record<string, unknown>,
    context: WorkflowExecutionContext,
    budgets: WorkflowBudget,
    startTime: number,
  ): Promise<void> {
    // 预算检查
    if (run.status !== 'running') return;

    const executedCount = Object.values(run.nodeResults).filter(
      r => r.status === 'success' || r.status === 'failed' || r.status === 'blocked',
    ).length;

    if (executedCount >= budgets.maxNodes) {
      run.status = 'blocked';
      run.stopReason = `超出最大节点数限制 (${budgets.maxNodes})`;
      return;
    }

    if (Date.now() - startTime > budgets.timeoutMs) {
      run.status = 'blocked';
      run.stopReason = `工作流超时 (${budgets.timeoutMs}ms)`;
      return;
    }

    const node = nodeMap.get(nodeId);
    if (!node) {
      run.errors.push(`节点 "${nodeId}" 不存在`);
      return;
    }

    // 跳过已执行节点
    const existing = run.nodeResults[nodeId];
    if (existing && existing.status !== 'pending') return;

    // 执行节点
    run.currentNodeIds = [nodeId];
    const result = await this.executeNode(node, run, input, context, budgets, startTime);
    run.nodeResults[nodeId] = result;
    run.updatedAt = new Date().toISOString();
    saveWorkflowRun(context.workspaceRoot, run);

    // 执行失败 → 停止
    if (result.status === 'failed' || result.status === 'blocked') {
      run.status = result.status === 'blocked' ? 'blocked' : 'failed';
      if (result.error) {
        run.errors.push(`节点 "${nodeId}" ${result.status}: ${result.error.message}`);
      }
      return;
    }

    // END 节点 → 停止
    if (node.type === 'END') {
      run.status = 'completed';
      return;
    }

    // 查找下游边
    const outgoing = adjacency.get(nodeId) || [];
    for (const edge of outgoing) {
      if (run.status !== 'running') break;

      // CONDITION 分支
      if (node.type === 'CONDITION') {
        const exprResult = evaluateCondition(node, edge, run);
        if (!exprResult) continue;
      }

      await this.executeFrom(edge.to, nodeMap, adjacency, def, run, input, context, budgets, startTime);
    }
  }

  /**
   * 执行单个节点
   */
  private async executeNode(
    node: WorkflowNode,
    run: WorkflowRun,
    input: Record<string, unknown>,
    context: WorkflowExecutionContext,
    budgets: WorkflowBudget,
    startTime: number,
  ): Promise<WorkflowNodeResult> {
    const result: WorkflowNodeResult = {
      nodeId: node.id,
      type: node.type,
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: '',
    };

    try {
      // 解析节点参数中的模板变量
      const inputSnapshot = buildInputSnapshot(input, run);

      switch (node.type) {
        case 'BEGIN':
          result.output = { ...input, _startedAt: result.startedAt };
          result.status = 'success';
          break;

        case 'END': {
          // END 可以指定导出的输出
          const endNode = node as WorkflowNode & { outputs?: Record<string, string> };
          if (endNode.params && typeof endNode.params === 'object') {
            const outputs = endNode.params as Record<string, string>;
            const collected: Record<string, unknown> = {};
            for (const [key, template] of Object.entries(outputs)) {
              collected[key] = resolveTemplate(String(template), input, inputSnapshot);
            }
            result.output = collected;
          } else {
            // 默认导出所有节点输出
            result.output = Object.fromEntries(
              Object.entries(run.nodeResults)
                .filter(([id]) => id !== node.id)
                .map(([id, r]) => [id, r.output]),
            );
          }
          result.status = 'success';
          break;
        }

        case 'TOOL': {
          if (!node.tool) {
            result.status = 'failed';
            result.error = { code: 'NO_TOOL', message: 'TOOL 节点缺少 tool', recoverable: false };
            break;
          }
          // 统一权限: allowedTools白名单 + readonly模式禁写工具
          const writeTools = new Set(['apply_patch', 'write_file', 'run_cmd', 'run_command']);
          if (context.mode === 'readonly' && writeTools.has(node.tool)) {
            result.status = 'blocked';
            result.error = { code: 'READONLY_BLOCKED', message: `只读模式禁止 ${node.tool}。切换模式后可执行。`, recoverable: false };
            break;
          }
          if (!context.allowedTools.includes(node.tool) && context.allowedTools.length > 0) {
            result.status = 'blocked';
            result.error = { code: 'TOOL_BLOCKED', message: `工具 "${node.tool}" 不在允许列表中`, recoverable: false };
            break;
          }
          const resolvedParams = node.params
            ? resolveObject(node.params, input, inputSnapshot)
            : {};
          const toolResp = await this.toolExecutor(node.tool, resolvedParams as Record<string, unknown>, context);
          result.output = toolResp.output;
          result.toolCalls = 1;
          run.totalToolCalls += 1;

          if (run.totalToolCalls > budgets.maxToolCalls) {
            run.status = 'blocked';
            run.stopReason = `超出最大工具调用数 (${budgets.maxToolCalls})`;
          }

          result.status = toolResp.success ? 'success' : 'failed';
          if (!toolResp.success && toolResp.error) {
            result.error = { code: 'TOOL_ERROR', message: toolResp.error, recoverable: false };
          }
          break;
        }

        case 'PIPELINE': {
          if (!node.pipeline) {
            result.status = 'failed';
            result.error = { code: 'NO_PIPELINE', message: 'PIPELINE 节点缺少 pipeline', recoverable: false };
            break;
          }
          const resolvedParams = node.params
            ? resolveObject(node.params, input, inputSnapshot)
            : {};
          const pipeResp = await this.pipelineExecutor(node.pipeline, resolvedParams as Record<string, unknown>, context);
          result.output = pipeResp.output;
          result.toolCalls = 1; // pipeline 内部可能多次调用，这里保守计 1
          run.totalToolCalls += 1;

          result.status = pipeResp.success ? 'success' : 'failed';
          if (!pipeResp.success && pipeResp.error) {
            result.error = { code: 'PIPELINE_ERROR', message: pipeResp.error, recoverable: false };
          }
          break;
        }

        case 'CONDITION': {
          if (!node.expression) {
            result.status = 'failed';
            result.error = { code: 'NO_EXPRESSION', message: 'CONDITION 节点缺少 expression', recoverable: false };
            break;
          }
          const resolvedExpr = resolveTemplate(node.expression, input, inputSnapshot);
          const exprResult = evaluateExpression(resolvedExpr);
          result.output = { result: exprResult, expression: node.expression, resolved: resolvedExpr };
          result.status = 'success';
          break;
        }

        default:
          result.status = 'failed';
          result.error = { code: 'UNKNOWN_TYPE', message: `未知节点类型: ${node.type}`, recoverable: false };
      }
    } catch (err) {
      result.status = 'failed';
      result.error = {
        code: 'EXECUTION_ERROR',
        message: (err as Error).message,
        recoverable: false,
      };
    }

    result.endedAt = new Date().toISOString();
    return result;
  }
}

// ---- Helpers ----

function buildAdjacency(edges: WorkflowEdge[]): Map<string, WorkflowEdge[]> {
  const adj = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    const list = adj.get(edge.from) || [];
    list.push(edge);
    adj.set(edge.from, list);
  }
  return adj;
}

/** 计算条件边是否应该走 */
function evaluateCondition(
  condNode: WorkflowNode,
  edge: WorkflowEdge,
  run: WorkflowRun,
): boolean {
  const condResult = run.nodeResults[condNode.id];
  if (!condResult || condResult.status !== 'success') return false;

  const condOutput = condResult.output as { result?: boolean } | undefined;
  const exprValue = condOutput?.result ?? false;

  // edge.condition 是 'true' 或 'false'，匹配 CONDITION 节点输出
  if (!edge.condition) return true; // 无条件边 → 总是走
  if (edge.condition === 'true') return exprValue === true;
  if (edge.condition === 'false') return exprValue === false;
  return true;
}

/** 构建模板解析所需的 input 快照 */
function buildInputSnapshot(
  input: Record<string, unknown>,
  run: WorkflowRun,
): Record<string, { output?: unknown }> {
  const snapshot: Record<string, { output?: unknown }> = {};
  for (const [nodeId, nr] of Object.entries(run.nodeResults)) {
    if (nr.status === 'success' || nr.status === 'failed') {
      snapshot[nodeId] = { output: nr.output };
    }
  }
  return snapshot;
}

function createFailedRun(
  def: WorkflowDefinition,
  input: Record<string, unknown>,
  reason: string,
): WorkflowRun {
  return {
    id: `run_${randomUUID().slice(0, 12)}`,
    workflowId: def.id,
    status: 'failed',
    input,
    nodeResults: {},
    currentNodeIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    errors: [reason],
    totalToolCalls: 0,
  };
}

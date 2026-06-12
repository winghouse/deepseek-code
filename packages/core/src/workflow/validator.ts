// ============================================================
// 工作流校验器 — schema / DAG / 引用完整性
// ============================================================

import type { WorkflowDefinition, WorkflowNode, WorkflowEdge } from 'deepseek-code-shared';

/** 已知的 dscode 工具名（只读 + 写） */
const KNOWN_TOOLS = new Set([
  'read_file', 'read_file_range', 'read_file_batch',
  'search_code', 'list_files', 'glob',
  'git_status', 'git_diff', 'git_log', 'git_show',
  'web_search', 'web_fetch',
  'read_json_path', 'list_scripts', 'file_exists',
  'find_references', 'detect_cross_platform',
  'run_cmd', 'write_file', 'apply_patch',
  'verifyFinding',
]);

/** 已知的 pipeline 名 */
const KNOWN_PIPELINES = new Set([
  'audit', 'repair', 'review_diff', 'review-diff', 'url_fetch', 'url-fetch',
]);

const VALID_NODE_TYPES = new Set(['BEGIN', 'END', 'TOOL', 'PIPELINE', 'CONDITION']);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 校验工作流定义
 */
export function validateWorkflow(def: WorkflowDefinition): ValidationResult {
  const errors: string[] = [];

  // ---- 基础字段 ----
  if (!def.id) errors.push('工作流缺少 id');
  if (!def.name) errors.push('工作流缺少 name');
  if (def.schemaVersion !== '0.1') errors.push(`schemaVersion 必须是 "0.1"，当前为 "${def.schemaVersion}"`);

  // ---- 节点 ----
  if (!def.nodes || def.nodes.length === 0) {
    errors.push('工作流至少需要一个节点');
    return { valid: false, errors };
  }

  const nodeIds = new Set<string>();
  let beginCount = 0;
  let endCount = 0;

  for (const node of def.nodes) {
    // ID
    if (!node.id) {
      errors.push('每个节点必须有 id');
      continue;
    }
    if (nodeIds.has(node.id)) {
      errors.push(`节点 ID 重复: "${node.id}"`);
    }
    nodeIds.add(node.id);

    // 类型
    if (!node.type || !VALID_NODE_TYPES.has(node.type)) {
      errors.push(`节点 "${node.id}" 类型不合法: "${node.type}"，支持: ${[...VALID_NODE_TYPES].join(', ')}`);
      continue;
    }

    if (node.type === 'BEGIN') beginCount++;
    if (node.type === 'END') endCount++;

    // TOOL 节点必须有 tool 字段
    if (node.type === 'TOOL') {
      if (!node.tool) {
        errors.push(`TOOL 节点 "${node.id}" 缺少 tool 字段`);
      } else if (!KNOWN_TOOLS.has(node.tool)) {
        // 不阻断（可能是将来新增的工具），但警告
        errors.push(`TOOL 节点 "${node.id}" 使用了未知工具: "${node.tool}"（如果确认可用请忽略）`);
      }
    }

    // PIPELINE 节点必须有 pipeline 字段
    if (node.type === 'PIPELINE') {
      if (!node.pipeline) {
        errors.push(`PIPELINE 节点 "${node.id}" 缺少 pipeline 字段`);
      } else if (!KNOWN_PIPELINES.has(node.pipeline)) {
        errors.push(`PIPELINE 节点 "${node.id}" 使用了未知管线: "${node.pipeline}"，已知: ${[...KNOWN_PIPELINES].join(', ')}`);
      }
    }

    // CONDITION 节点必须有 expression
    if (node.type === 'CONDITION') {
      if (!node.expression) {
        errors.push(`CONDITION 节点 "${node.id}" 缺少 expression`);
      }
    }
  }

  if (beginCount === 0) errors.push('工作流必须有且仅有一个 BEGIN 节点（当前 0 个）');
  if (beginCount > 1) errors.push(`工作流只能有一个 BEGIN 节点（当前 ${beginCount} 个）`);
  if (endCount === 0) errors.push('工作流至少需要一个 END 节点');

  // ---- 边 ----
  if (!def.edges || def.edges.length === 0) {
    errors.push('工作流至少需要一条边');
  } else {
    for (const edge of def.edges) {
      if (!edge.from) errors.push('边缺少 from');
      else if (!nodeIds.has(edge.from)) errors.push(`边引用了不存在的源节点: "${edge.from}"`);

      if (!edge.to) errors.push('边缺少 to');
      else if (!nodeIds.has(edge.to)) errors.push(`边引用了不存在的目标节点: "${edge.to}"`);
    }
  }

  // ---- DAG 无环检测 ----
  if (nodeIds.size > 1 && !errors.some(e => e.includes('不存在的'))) {
    const cycleNode = detectCycle(def.nodes, def.edges);
    if (cycleNode) {
      errors.push(`工作流包含环路（节点 "${cycleNode}" 参与循环引用）`);
    }
  }

  // ---- 孤立节点检测（排除 BEGIN/END） ----
  if (def.edges && def.edges.length > 0) {
    const connected = new Set<string>();
    for (const edge of def.edges) {
      connected.add(edge.from);
      connected.add(edge.to);
    }
    const isolated = def.nodes
      .filter(n => n.type !== 'BEGIN' && n.type !== 'END')
      .map(n => n.id)
      .filter(id => !connected.has(id));
    if (isolated.length > 0) {
      errors.push(`存在孤立节点: ${isolated.join(', ')}`);
    }
  }

  // ---- 模板变量引用校验 (${node_id.result...}) ----
  for (const node of def.nodes) {
    const referIds = extractTemplateRefs(node);
    for (const refId of referIds) {
      if (!nodeIds.has(refId)) {
        errors.push(`节点 "${node.id}" 引用了不存在的节点: "${refId}"（模板变量）`);
      }
    }
  }

  // ---- 预算合理性 ----
  if (def.budgets) {
    if (def.budgets.maxNodes !== undefined && def.budgets.maxNodes < 1) {
      errors.push('budgets.maxNodes 必须 >= 1');
    }
    if (def.budgets.maxToolCalls !== undefined && def.budgets.maxToolCalls < 1) {
      errors.push('budgets.maxToolCalls 必须 >= 1');
    }
    if (def.budgets.timeoutMs !== undefined && def.budgets.timeoutMs < 1000) {
      errors.push('budgets.timeoutMs 必须 >= 1000');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---- 环检测 (DFS) ----

function detectCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): string | null {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) || [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const node of nodes) color.set(node.id, WHITE);

  function dfs(nodeId: string): string | null {
    color.set(nodeId, GRAY);
    for (const neighbor of adjacency.get(nodeId) || []) {
      const c = color.get(neighbor);
      if (c === GRAY) return nodeId; // 回边 → 有环
      if (c === WHITE) {
        const found = dfs(neighbor);
        if (found) return found;
      }
    }
    color.set(nodeId, BLACK);
    return null;
  }

  for (const node of nodes) {
    if (color.get(node.id) === WHITE) {
      const found = dfs(node.id);
      if (found) return found;
    }
  }
  return null;
}

// ---- 模板变量引用提取 ----

function extractTemplateRefs(node: WorkflowNode): string[] {
  const refs: string[] = [];
  const searchStr = JSON.stringify({ expression: node.expression, params: node.params });
  for (const match of searchStr.matchAll(/\$\{([^}]+)\}/g)) {
    const varPath = match[1].trim();
    // ${node_id.result.xxx} 或 ${node_id.xxx}
    if (varPath.startsWith('input.')) continue;
    const dotIdx = varPath.indexOf('.');
    if (dotIdx > 0) {
      refs.push(varPath.slice(0, dotIdx));
    } else {
      refs.push(varPath);
    }
  }
  return [...new Set(refs)];
}

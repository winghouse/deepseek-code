// ============================================================
// 模板变量解析 — ${input.xxx} / ${node_id.result.path}
// 默认截断 8000 字符，替换后过 secret filter
// ============================================================

import { MAX_TEMPLATE_VALUE_LENGTH } from 'deepseek-code-shared';

/**
 * 解析模板字符串中的变量引用
 *
 * 支持语法：
 *   ${input.key}                    → 工作流输入
 *   ${node_id.result}               → 节点完整输出
 *   ${node_id.result.path.to.value} → 嵌套路径
 *   ${node_id.result.items[0].url}  → 数组索引
 *
 * 安全限制：
 *   - 单个变量展开后最长 8000 字符
 *   - 超出截断并标记 [TRUNCATED]
 *   - 替换结果过 secret filter（由调用方处理）
 */
export function resolveTemplate(
  template: string,
  input: Record<string, unknown>,
  nodeResults: Record<string, { output?: unknown }>,
): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, varPath: string) => {
    const value = resolveValue(varPath.trim(), input, nodeResults);
    const str = stringify(value);
    if (str.length > MAX_TEMPLATE_VALUE_LENGTH) {
      return str.slice(0, MAX_TEMPLATE_VALUE_LENGTH) + '\n... [TRUNCATED]';
    }
    return str;
  });
}

/**
 * 递归解析对象/数组中的所有模板变量
 */
export function resolveObject<T>(
  obj: T,
  input: Record<string, unknown>,
  nodeResults: Record<string, { output?: unknown }>,
): T {
  if (typeof obj === 'string') {
    return resolveTemplate(obj, input, nodeResults) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => resolveObject(item, input, nodeResults)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveObject(value, input, nodeResults);
    }
    return result as T;
  }
  return obj;
}

// ---- 内部 ----

function resolveValue(
  varPath: string,
  input: Record<string, unknown>,
  nodeResults: Record<string, { output?: unknown }>,
): unknown {
  // ${input.xxx}
  if (varPath.startsWith('input.')) {
    const key = varPath.slice(6);
    return deepGet(input, key);
  }

  // ${node_id.result.xxx} 或 ${node_id.xxx}（简写）
  const dotIdx = varPath.indexOf('.');
  if (dotIdx > 0) {
    const nodeId = varPath.slice(0, dotIdx);
    let rest = varPath.slice(dotIdx + 1);
    const nodeResult = nodeResults[nodeId];
    if (!nodeResult || nodeResult.output === undefined) return '';
    // 跳过 'result' 关键字
    if (rest === 'result') return nodeResult.output;
    if (rest.startsWith('result.')) {
      rest = rest.slice(7);
    }
    return deepGet(nodeResult.output as Record<string, unknown>, rest);
  }

  // 裸 nodeId → 整个输出
  const nodeResult = nodeResults[varPath];
  if (nodeResult && nodeResult.output !== undefined) return nodeResult.output;

  return '';
}

function deepGet(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return '';
  const parts = parsePath(path);
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return '';
    if (typeof part === 'number') {
      if (Array.isArray(current)) {
        current = current[part];
      } else {
        return '';
      }
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return '';
    }
  }
  return current;
}

function parsePath(path: string): Array<string | number> {
  const parts: Array<string | number> = [];
  // 按 . 分割，同时处理 [index]
  const segments = path.split('.');
  for (const seg of segments) {
    const arrMatch = seg.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      parts.push(arrMatch[1]);
      parts.push(parseInt(arrMatch[2], 10));
    } else if (/^\d+$/.test(seg)) {
      parts.push(parseInt(seg, 10));
    } else {
      parts.push(seg);
    }
  }
  return parts;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

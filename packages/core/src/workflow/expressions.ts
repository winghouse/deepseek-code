// ============================================================
// 安全条件表达式 — 不用 eval / new Function
// 支持有限的操作符：== != > >= < <= contains exists and or not
// ============================================================

/** 字面量类型 */
type Value = string | number | boolean | null;

/** Token */
interface Token {
  type: 'value' | 'op' | 'paren_open' | 'paren_close';
  value: string;
}

/** 操作符 */
type Op = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'exists' | 'and' | 'or' | 'not';

const OPS: Op[] = ['==', '!=', '>=', '<=', '>', '<', 'contains', 'exists', 'and', 'or', 'not'];

/**
 * 安全解析表达式字符串，返回 boolean
 *
 * 支持语法：
 *   "${node_id.result.path} == true"
 *   "${node_id.result.count} > 0"
 *   "${node_id.result.text} contains 'error'"
 *   "not ${node_id.result.empty}"
 *   "${a.result.ok} and ${b.result.ok}"
 *
 * 不支持： 函数调用、赋值、new、原型链
 */
export function evaluateExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return true;

  try {
    const tokens = tokenize(trimmed);
    // 特殊处理: 如果只有单个值，直接判断 truthy
    if (tokens.length === 1 && tokens[0].type === 'value') {
      return isTruthy(coerceValue(tokens[0].value));
    }
    return parseAndEval(tokens);
  } catch {
    // 表达式解析失败 → 默认 false（安全兜底）
    return false;
  }
}

// ---- Tokenizer ----

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    // 跳过空白
    if (/\s/.test(expr[i])) {
      i++;
      continue;
    }

    // 括号
    if (expr[i] === '(') {
      tokens.push({ type: 'paren_open', value: '(' });
      i++;
      continue;
    }
    if (expr[i] === ')') {
      tokens.push({ type: 'paren_close', value: ')' });
      i++;
      continue;
    }

    // 字符串字面量 '...'
    if (expr[i] === "'" || expr[i] === '"') {
      const quote = expr[i];
      let j = i + 1;
      while (j < expr.length && expr[j] !== quote) j++;
      tokens.push({ type: 'value', value: expr.slice(i + 1, j) });
      i = j + 1;
      continue;
    }

    // 操作符（最长匹配，>= 优先于 >）
    const op = OPS.find(o => expr.startsWith(o, i));
    if (op) {
      tokens.push({ type: 'op', value: op });
      i += op.length;
      continue;
    }

    // 字面量（数字/布尔/null）
    const remaining = expr.slice(i);
    const litMatch = remaining.match(/^(true|false|null|\d+(?:\.\d+)?)/);
    if (litMatch) {
      tokens.push({ type: 'value', value: litMatch[1] });
      i += litMatch[1].length;
      continue;
    }

    // 模板变量占位符 → 语法上当作 value（真实值在执行时已替换）
    // 这里如果出现 ${...} 说明还没被替换，当空字符串处理
    if (expr.startsWith('${', i)) {
      let j = i + 2;
      let depth = 1;
      while (j < expr.length && depth > 0) {
        if (expr[j] === '{') depth++;
        else if (expr[j] === '}') depth--;
        j++;
      }
      // 未替换的模板变量 → 当作空字符串
      tokens.push({ type: 'value', value: '' });
      i = j;
      continue;
    }

    // 裸词 (如变量名)
    const wordMatch = remaining.match(/^[\w.\[\]_-]+/);
    if (wordMatch) {
      tokens.push({ type: 'value', value: wordMatch[1] });
      i += wordMatch[1].length;
      continue;
    }

    i++; // 未知字符跳过
  }

  return tokens;
}

// ---- Parser + Evaluator (递归下降) ----

let pos = 0;
let toks: Token[] = [];

function parseAndEval(tkns: Token[]): boolean {
  toks = tkns;
  pos = 0;
  return expr_or();
}

function expr_or(): boolean {
  let left = expr_and();
  while (pos < toks.length && toks[pos].type === 'op' && toks[pos].value === 'or') {
    pos++;
    const right = expr_and();
    left = left || right;
  }
  return left;
}

function expr_and(): boolean {
  let left = expr_not();
  while (pos < toks.length && toks[pos].type === 'op' && toks[pos].value === 'and') {
    pos++;
    const right = expr_not();
    left = left && right;
  }
  return left;
}

function expr_not(): boolean {
  if (pos < toks.length && toks[pos].type === 'op' && toks[pos].value === 'not') {
    pos++;
    return !expr_compare();
  }
  return expr_compare();
}

function expr_compare(): boolean {
  if (pos < toks.length && toks[pos].type === 'paren_open') {
    pos++;
    const result = expr_or();
    // 期望闭合括号
    if (pos < toks.length && toks[pos].type === 'paren_close') pos++;
    return result;
  }

  const left = primary();
  if (pos < toks.length && toks[pos].type === 'op') {
    const op = toks[pos].value as Op;
    if (isCompareOp(op)) {
      pos++;
      const right = primary();
      return compare(op, left, right);
    }
  }
  // 无操作符 → 判断 truthy
  return isTruthy(left);
}

function primary(): Value {
  if (pos >= toks.length) return null;
  const tok = toks[pos++];
  if (tok.type === 'value') return coerceValue(tok.value);
  return null;
}

// ---- Helpers ----

function isCompareOp(op: string): boolean {
  return op === '==' || op === '!=' || op === '>' || op === '>=' || op === '<' || op === '<=' || op === 'contains' || op === 'exists';
}

function coerceValue(raw: string): Value {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return parseFloat(raw);
  return raw; // 字符串
}

function compare(op: Op, left: Value, right: Value): boolean {
  switch (op) {
    case '==': return left == right;   // eslint-disable-line eqeqeq
    case '!=': return left != right;   // eslint-disable-line eqeqeq
    case '>': return Number(left) > Number(right);
    case '>=': return Number(left) >= Number(right);
    case '<': return Number(left) < Number(right);
    case '<=': return Number(left) <= Number(right);
    case 'contains': return String(left).includes(String(right));
    case 'exists': return left !== null && left !== undefined && left !== '';
    default: return false;
  }
}

function isTruthy(v: Value): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0 && v !== 'false' && v !== 'null';
  return true;
}

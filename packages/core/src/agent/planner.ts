// ============================================================
// Agent Runtime — 计划生成器
// ============================================================

import type { ChatMessage, ExecutionPlan, RepoInfo, PlanStep } from 'deepseek-code-shared';
import type { ModelClient } from '../model/types.js';

function buildPlanPrompt(task: string, mode?: string): string {
  const lang = isChinese(task) ? '简体中文' : 'English';
  const modeNote = mode === 'readonly'
    ? '当前是只读模式，禁止 run_command/apply_patch/write_file。只能静态分析。'
    : '';

  // 审查/审计/优化类任务的专用引导
  const isAudit = /审查|审计|检查.*优化|代码质量|代码.*问题|安全.*漏洞|架构.*问题/i.test(task);
  const auditExample = isAudit
    ? `\n这是一个代码审查任务。参照以下示例生成计划（根据实际项目调整文件路径）：\n` +
      `{"steps":[` +
      `{"order":1,"action":"read","description":"读取项目配置了解技术栈和依赖","targetFiles":["package.json","tsconfig.base.json"]},` +
      `{"order":2,"action":"read","description":"读取核心入口和路由模块","targetFiles":["packages/core/src/index.ts","packages/cli/src/index.ts"]},` +
      `{"order":3,"action":"read","description":"审查安全/权限模块","targetFiles":["packages/core/src/safety/permissions.ts"]},` +
      `{"order":4,"action":"read","description":"审查错误处理和边界情况","targetFiles":["packages/core/src/tools/executors.ts"]},` +
      `{"order":5,"action":"read","description":"审查最近修改的模块","targetFiles":["<从 git diff 找到的文件>"]},` +
      `{"order":6,"action":"verify","description":"逐条验证前几步的发现：用 read_file_range 确认关键证据的文件:行号，用 glob 验证涉及的文件是否存在，用 search_code 确认引用关系"}],` +
      `"complexity":"medium","recommendedModel":"deepseek-v4-pro"}\n` +
      `铁律（违反会导致幻觉）：\n` +
      `- 说"缺少X"前，必须先用 glob X 或 search_code X 确认真的没有\n` +
      `- 说"X行/个/次"等数值前，必须先用 read_file 或 search_code 确认实际数字\n` +
      `- 每个发现必须标注证据来源，格式: [文件:行号] 实际代码片段\n` +
      `- 禁止"读取项目文件""分析项目文件"这类无具体目标/文件名的步骤`
    : '';

  const basePrompt = isAudit
    ? `你是 DeepSeek Code Agent。${modeNote}${auditExample}\n只输出JSON，不要解释。`
    : `你是 DeepSeek Code Agent。${modeNote}\n生成**执行步骤**，每步写具体操作和文件名，禁止"分析/执行项目文件"这类泛化描述。最多8步。只输出JSON:{"steps":[{"order":1,"action":"read","description":"读取 package.json 了解依赖","targetFiles":["package.json"]}],"complexity":"simple|medium|complex","recommendedModel":"deepseek-v4-flash|deepseek-v4-pro"}。请用${lang}。`;
  return basePrompt;
}

/** 简单判断是否主要为中文输入 */
function isChinese(text: string): boolean {
  const chineseChars = (text.match(/[一-鿿]/g) ?? []).length;
  const totalChars = text.replace(/\s/g, '').length;
  return totalChars > 0 && chineseChars / totalChars > 0.3;
}

/**
 * 生成执行计划
 */
export async function generatePlan(
  model: ModelClient,
  repoInfo: RepoInfo,
  taskDescription: string,
  repoSummary: string,
  mode?: string,
): Promise<ExecutionPlan> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildPlanPrompt(taskDescription, mode) },
    {
      role: 'user',
      content: `## 项目\n${repoSummary}\n\n## 需求\n${taskDescription}\n\n生成 JSON 计划。`,
    },
  ];

  try {
    const response = await model.chat(messages, {
      temperature: 0.1,
      responseFormat: 'json_object', // DeepSeek V4: 确保输出合法 JSON
    });

    const content = response.content;
    if (!content) return buildFallbackPlan(taskDescription, repoInfo);

    const plan = parsePlanJson(content, taskDescription, repoInfo);

    // 如果步骤数为 0，JSON 可能解析失败，重试一次
    if (plan.steps.length === 0) {
      console.log('⚠️ 计划解析为空，重试中...');
      const retryResponse = await model.chat(
        [
          ...messages,
          { role: 'assistant', content },
          {
            role: 'user',
            content: '你的输出格式有误，无法解析出步骤。请严格按照示例格式输出，每个步骤必须有 order、action、description 三个字段。',
          },
        ],
        { temperature: 0.1, maxTokens: 2048 },
      );

      if (retryResponse.content) {
        const retryPlan = parsePlanJson(retryResponse.content, taskDescription, repoInfo);
        if (retryPlan.steps.length > 0) return retryPlan;
      }

      // 重试也失败，用降级计划
      console.log('⚠️ 重试失败，使用降级计划');
      return buildFallbackPlan(taskDescription, repoInfo);
    }

    return plan;
  } catch {
    return buildFallbackPlan(taskDescription, repoInfo);
  }
}

/**
 * 通用 JSON 计划解析器 —— 兼容模型可能输出的所有格式
 */
export function parsePlanJson(
  rawText: string,
  taskDescription: string,
  repoInfo: RepoInfo | null,
): ExecutionPlan {
  const jsonStr = extractJson(rawText);
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return buildFallbackPlan(taskDescription, repoInfo);
  }

  // 智能提取步骤数组
  const rawSteps = extractStepsArray(parsed);
  const obj = (typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : {};

  // 从所有键值中提取字符串字段，取最长的作为 taskDescription
  const stringFields = collectStringFields(obj).filter(
    (v) => typeof v === 'string' && v.length >= 2,
  ) as string[];
  const bestDesc = stringFields.sort((a, b) => b.length - a.length)[0];

  return {
    taskDescription: bestDesc ?? taskDescription,
    complexity: validateComplexity(obj.complexity ?? obj.level ?? obj.difficulty),
    recommendedModel: validateModel(obj.recommendedModel ?? obj.model),
    steps: rawSteps.map((s, i) => parseStep(s, i)),
    estimatedFiles: extractStringArray(obj.estimatedFiles ?? obj.files ?? []),
    risks: extractStringArray(obj.risks ?? []),
  };
}

/** 智能提取步骤数组 */
function extractStepsArray(parsed: unknown): Record<string, unknown>[] {
  // 0. 如果 parsed 本身是数组（纯数组 JSON），直接返回
  if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
    return parsed as Record<string, unknown>[];
  }

  const obj = parsed as Record<string, unknown>;

  // 1. 优先从 named keys 中取
  const stepKeys = ['steps', 'plan', 'tasks', 'actions'];
  for (const key of stepKeys) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
      return val as Record<string, unknown>[];
    }
  }

  // 2. 递归查找其他对象数组（过滤掉纯字符串/数字数组如 estimatedFiles）
  function findObjArrays(o: unknown, depth: number): unknown[][] {
    if (depth > 3) return [];
    const results: unknown[][] = [];
    if (typeof o === 'object' && o !== null) {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (Array.isArray(v) && v.length > 0) {
          // 只收元素为对象的数组（步骤数组的特征）
          if (typeof v[0] === 'object' && v[0] !== null) {
            results.push(v as Record<string, unknown>[]);
          }
        }
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          results.push(...findObjArrays(v, depth + 1));
        }
      }
    }
    return results;
  }

  const objArrays = findObjArrays(obj, 0);
  // 取最长的
  objArrays.sort((a, b) => b.length - a.length);
  return (objArrays[0] ?? []) as Record<string, unknown>[];
}

/** 收集对象中所有 top-level 字符串值 */
function collectStringFields(obj: unknown): unknown[] {
  if (typeof obj !== 'object' || obj === null) return [];
  return Object.values(obj as Record<string, unknown>);
}

/** 解析单个步骤，兼容所有可能的字段名 */
function parseStep(s: Record<string, unknown>, index: number): PlanStep {
  // 序号：order > id > step > index > number > 默认索引
  const order = pickNumber(s, ['order', 'id', 'step', 'index', 'number'], index + 1);

  // 动作：action > type > 默认 analyze
  const action = pickAction(s, ['action', 'type']);

  // 描述：取最长的字符串字段（排除已知短字段）
  const descFields = Object.entries(s)
    .filter(
      ([k, v]) =>
        typeof v === 'string' &&
        !['action', 'type', 'command', 'step', 'id', 'file', 'directory', 'path', 'cwd'].includes(k) &&
        v.length > 0,
    )
    .sort(([, a], [, b]) => (b as string).length - (a as string).length);

  // 用动作+目标拼出可读描述
  const actionLabel: Record<string, string> = {
    read: '读取', search: '搜索', analyze: '分析', modify: '修改',
    run_command: '执行', verify: '验证', read_file: '读取', search_code: '搜索',
  };
  const fileList = extractStringArray(s.targetFiles ?? s.files ?? s.file ?? []);
  const actionText = actionLabel[action] ?? action;
  const fileText = fileList.length > 0 ? ` ${fileList.slice(0, 2).join(', ')}` : '';

  // 取第一个有效的描述字段（排除文件路径）
  const bestDesc = descFields.find(([, v]) => !/^[A-Z]:\\|\//.test(v as string))?.[1] as string | undefined;

  const description =
    (bestDesc && bestDesc.length > 2 ? bestDesc : undefined) ??
    `${actionText}${fileText || '项目文件'}`;

  // 文件列表
  const targetFiles = extractStringArray(s.targetFiles ?? s.files ?? s.file ?? []);

  // 命令
  const command = typeof s.command === 'string' ? s.command : undefined;

  // 原因
  const reason =
    (typeof s.reason === 'string' ? s.reason : undefined) ??
    (typeof s.purpose === 'string' ? s.purpose : undefined) ??
    '';

  return { order, action, description, targetFiles, command, reason };
}

function pickNumber(obj: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = parseInt(v, 10);
      if (!isNaN(n)) return n;
    }
  }
  return fallback;
}

function pickAction(
  obj: Record<string, unknown>,
  keys: string[],
): PlanStep['action'] {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string') {
      const a = v.toLowerCase();
      if (['read', 'search', 'analyze', 'modify', 'run_command', 'verify'].includes(a)) {
        return a as PlanStep['action'];
      }
      // 映射中文/近义词
      if (a.includes('read') || a.includes('读')) return 'read';
      if (a.includes('search') || a.includes('搜') || a.includes('grep')) return 'search';
      if (a.includes('analyz') || a.includes('分析')) return 'analyze';
      if (a.includes('modif') || a.includes('edit') || a.includes('改') || a.includes('patch'))
        return 'modify';
      if (a.includes('run') || a.includes('execut') || a.includes('命令') || a.includes('test'))
        return 'run_command';
      if (a.includes('verif') || a.includes('check') || a.includes('验证') || a.includes('test'))
        return 'verify';
    }
  }
  return 'analyze';
}

/** 从任意值提取字符串数组 */
function extractStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v) => typeof v === 'string') as string[];
  if (typeof val === 'string') return [val];
  return [];
}

function validateComplexity(v: unknown): ExecutionPlan['complexity'] {
  if (typeof v === 'string' && ['simple', 'medium', 'complex'].includes(v)) {
    return v as ExecutionPlan['complexity'];
  }
  return 'medium';
}

function validateModel(v: unknown): ExecutionPlan['recommendedModel'] {
  if (typeof v === 'string' && ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(v)) {
    return v as ExecutionPlan['recommendedModel'];
  }
  return 'deepseek-v4-pro';
}

/**
 * 降级计划
 */
function buildFallbackPlan(taskDescription: string, repo: RepoInfo | null): ExecutionPlan {
  const steps: PlanStep[] = [];

  steps.push({
    order: 1,
    action: 'read',
    description: '读取项目关键文件',
    targetFiles: ['package.json', ...(repo?.structure.entryFiles ?? []), ...(repo?.structure.routeFiles.slice(0, 5) ?? [])].filter(Boolean),
    reason: '了解项目技术栈和代码结构',
  });

  steps.push({
    order: 2,
    action: 'search',
    description: '搜索与任务相关的代码',
    targetFiles: [],
    reason: '找到与任务相关的代码位置',
  });

  steps.push({
    order: 3,
    action: 'analyze',
    description: '分析代码，定位关键位置',
    targetFiles: [],
    reason: '确定改动范围',
  });

  return {
    taskDescription,
    complexity: 'medium',
    recommendedModel: 'deepseek-v4-pro',
    steps,
    estimatedFiles: [...(repo?.structure.entryFiles ?? []), ...(repo?.structure.routeFiles ?? [])],
    risks: ['需要进一步确认改动范围'],
  };
}

function extractJson(text: string): string {
  const block = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (block) return block[1].trim();

  // 判断是对象还是数组开头
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');

  // 数组开头（且数组在对象之前）→ 提取数组
  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    const arrEnd = text.lastIndexOf(']');
    if (arrEnd > arrStart) return text.slice(arrStart, arrEnd + 1);
  }

  // 对象开头 → 提取对象
  if (objStart !== -1) {
    const objEnd = text.lastIndexOf('}');
    if (objEnd > objStart) return text.slice(objStart, objEnd + 1);
  }

  return text;
}

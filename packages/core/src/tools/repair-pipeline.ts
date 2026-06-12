// ============================================================
// Repair Pipeline — debug_task 专用
// 错误解析 → 文件定位 → 根因分析 → 补丁生成 → 验证
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoInfo } from 'deepseek-code-shared';
import { scanRepo } from '../context/scanner.js';

// ═══ Types ═══

export interface RepairResult {
  success: boolean;
  summary: string;
  filesExamined: string[];
  rootCause?: string;
  rootCauseConfidence?: number;
  patchProposal?: string;
  suggestedFix?: string;
  errorLocation?: ParsedError;
  elapsedMs: number;
}

export interface ParsedError {
  file?: string;
  line?: number;
  column?: number;
  errorCode?: string;
  message: string;
  category: 'typescript' | 'eslint' | 'build' | 'test' | 'runtime' | 'unknown';
  raw: string;
}

export interface RepairPipelineOptions {
  workingDir: string;
  taskDescription: string;
  mode: 'readonly' | 'ask' | 'auto';
  errorContext?: string;
  proClient?: { chat(prompt: string): Promise<string> };
  flashClient?: { chat(prompt: string): Promise<string> };
  onProgress?: (step: string) => void;
}

// ═══ Error Parser ═══

/**
 * 从错误文本中提取结构化信息
 * 支持 TypeScript / ESLint / Build / Test 四种错误格式
 */
export function parseErrors(errorText: string): ParsedError[] {
  const errors: ParsedError[] = [];

  // Pattern 1: TypeScript — src/file.ts(10,5): error TS2345: Argument of type...
  const tsPattern = /([a-zA-Z0-9_/.-]+\.(?:ts|tsx|js|jsx))\s*\((\d+)\s*,?\s*(\d+)?\)\s*:\s*error\s+(TS\d+)\s*:\s*(.+?)(?=\n\s*(?:[a-zA-Z0-9_/.-]+\.(?:ts|tsx|js|jsx)\s*\()|$)/gs;
  for (const m of errorText.matchAll(tsPattern)) {
    errors.push({
      file: m[1], line: parseInt(m[2]), column: m[3] ? parseInt(m[3]) : undefined,
      errorCode: m[4], message: m[5].trim(),
      category: 'typescript', raw: m[0],
    });
  }

  // Pattern 1b: Simpler TS — error TS2345 at file.ts:10:5
  const tsSimplePattern = /error\s+(TS\d+)[:\s]+(.+?)(?:at\s+)?([a-zA-Z0-9_/.-]+\.(?:ts|tsx|js|jsx))[:](\d+)(?:[:](\d+))?/gi;
  for (const m of errorText.matchAll(tsSimplePattern)) {
    if (!errors.some((e) => e.errorCode === m[1] && e.file === m[3])) {
      errors.push({
        file: m[3], line: parseInt(m[4]), column: m[5] ? parseInt(m[5]) : undefined,
        errorCode: m[1], message: m[2].trim(),
        category: 'typescript', raw: m[0],
      });
    }
  }

  // Pattern 2: ESLint — /path/to/file.ts:10:5: error message rule-id
  const eslintPattern = /([a-zA-Z0-9_/.-]+\.(?:ts|tsx|js|jsx))[:](\d+)[:](\d+)\s*:\s*(error|warning)\s+(.+?)\s{2,}([a-z0-9/-]+)/g;
  for (const m of errorText.matchAll(eslintPattern)) {
    errors.push({
      file: m[1], line: parseInt(m[2]), column: parseInt(m[3]),
      errorCode: m[6], message: `${m[4]}: ${m[5]}`,
      category: 'eslint', raw: m[0],
    });
  }

  // Pattern 3: Build — Error: Cannot find module 'x' or Module not found
  const buildPattern = /(Error|ModuleNotFoundError|Build failed)[:\s]+(.+?)(?:\n|$)/gi;
  for (const m of errorText.matchAll(buildPattern)) {
    errors.push({
      message: m[2].trim(),
      category: 'build', raw: m[0],
    });
  }

  // Pattern 4: Test — FAIL src/__tests__/file.test.ts > suite > test name
  const testFailPattern = /FAIL\s+(\S+\.test\.\w+)\s*>\s*(.+?)(?:\n|$)/g;
  for (const m of errorText.matchAll(testFailPattern)) {
    errors.push({
      file: m[1],
      message: m[2].trim(),
      category: 'test', raw: m[0],
    });
  }

  // Pattern 4b: Test assertion — Expected: X, Received: Y / AssertionError (dotAll for multiline)
  const testAssertPattern = /\b(AssertionError|Expected|Received|expect\()\s*.+?(?=\n\s*(?:at\s+|$)|$)/gs;
  for (const m of errorText.matchAll(testAssertPattern)) {
    if (!errors.some((e) => e.message.includes(m[0].slice(0, 30)))) {
      errors.push({
        message: m[0].trim(),
        category: 'test', raw: m[0],
      });
    }
  }
  // Fallback for test: ● marker (Jest)
  if (errors.length === 0 || !errors.some((e) => e.category === 'test')) {
    const jestPattern = /[●]\s*(.+?)(?:\n|$)/g;
    for (const m of errorText.matchAll(jestPattern)) {
      errors.push({
        message: m[1].trim(),
        category: 'test', raw: m[0],
      });
    }
  }

  // Fallback: any line that looks like an error
  if (errors.length === 0) {
    const errorLines = errorText.split('\n').filter((l) => /error|fail|exception|panic|crash/i.test(l));
    for (const line of errorLines.slice(0, 5)) {
      errors.push({
        message: line.trim().slice(0, 200),
        category: 'unknown', raw: line,
      });
    }
  }

  return errors;
}

/** 从任务描述中提取文件路径 */
export function extractFilesFromTask(task: string): string[] {
  const filePattern = /([a-zA-Z0-9_/.-]+\.(?:tsx|json|ts|jsx|js|py|java|go|rs|vue|css|scss))/g;
  return [...new Set([...task.matchAll(filePattern)].map((m) => m[1]))];
}

/** 读取文件片段（错误行前后各 15 行） */
function readFileSnippet(filePath: string, line?: number, context: number = 15): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (!line) {
      return lines.slice(0, 50).join('\n');
    }
    const start = Math.max(0, line - context - 1);
    const end = Math.min(lines.length, line + context);
    return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
  } catch {
    return null;
  }
}

// ═══ Root Cause Analysis ═══

export function analyzeRootCausePattern(errors: ParsedError[], fileSnippets: Map<string, string | null>): string | null {
  for (const e of errors) {
    switch (e.errorCode) {
      case 'TS2345':
        return `类型不匹配 (TS2345): 实参类型与形参类型不兼容。检查 ${e.file ?? '相关文件'} 第${e.line ?? '?'}行附近的参数传递。`;
      case 'TS2339':
        return `属性不存在 (TS2339): 访问的类型上不存在该属性。检查 ${e.file ?? '相关文件'} 的类型定义是否缺少该属性。`;
      case 'TS2304':
        return `找不到名称 (TS2304): 导入缺失或变量名拼写错误。检查 ${e.file ?? '相关文件'} 的 import 语句。`;
      case 'TS2322':
        return `类型分配错误 (TS2322): 赋值类型不兼容。检查 ${e.file ?? '相关文件'} 第${e.line ?? '?'}行的变量类型声明。`;
      case 'TS7006':
        return `隐式 any (TS7006): 参数缺少类型注解。在 ${e.file ?? '相关文件'} 第${e.line ?? '?'}行为参数添加显式类型。`;
      case 'TS18046':
        return `可能为 null/undefined (TS18046): 变量可能为空。在 ${e.file ?? '相关文件'} 添加空值检查或非空断言。`;
      case 'TS2307':
        return `找不到模块 (TS2307): import 路径错误或模块不存在。检查 ${e.file ?? '相关文件'} 的导入路径。`;
    }
  }

  // Pattern-based analysis without specific error codes
  for (const e of errors) {
    if (e.category === 'build' && e.message.includes('Cannot find module')) {
      const modMatch = e.message.match(/Cannot find module ['"](.+?)['"]/);
      return modMatch
        ? `模块缺失: 找不到 "${modMatch[1]}"。检查是否已安装依赖或 import 路径是否正确。`
        : `构建失败: ${e.message.slice(0, 100)}`;
    }
    if (e.category === 'test') {
      return `测试失败: ${e.message.slice(0, 200)}。检查测试断言和被测代码逻辑是否一致。`;
    }
    if (e.category === 'eslint') {
      return `Lint 错误 (${e.errorCode ?? 'unknown'}): ${e.message.slice(0, 200)}`;
    }
  }

  return null;
}

// ═══ Pro Model Analysis ═══

async function proAnalyze(
  errors: ParsedError[],
  fileSnippets: Map<string, string | null>,
  taskDescription: string,
  repoInfo: RepoInfo | null,
  client: { chat(prompt: string): Promise<string> },
): Promise<string> {
  const errorSummary = errors.map((e) =>
    `[${e.category}] ${e.file ? `${e.file}:${e.line ?? '?'}` : ''} ${e.errorCode ? `${e.errorCode}: ` : ''}${e.message.slice(0, 200)}`,
  ).join('\n');

  const codeContext = [...fileSnippets.entries()]
    .filter(([, snippet]) => snippet !== null)
    .map(([file, snippet]) => `### ${file}\n\`\`\`typescript\n${snippet}\n\`\`\``)
    .join('\n\n');

  const prompt = `你是一个 TypeScript 调试专家。分析以下错误并提供修复方案。

**任务描述:** ${taskDescription.slice(0, 200)}
**项目:** ${repoInfo?.name ?? '未知'} (${repoInfo?.techStack.language ?? 'TypeScript'}, ${repoInfo?.techStack.framework ?? '无框架'})

**错误信息:**
${errorSummary}

**相关代码:**
${codeContext || '(无代码上下文)'}

请输出 JSON：
{
  "rootCause": "根因分析（一句话）",
  "confidence": 0.0-1.0,
  "fixDescription": "修复方案描述",
  "patch": "具体的代码修改（如果可以直接生成 patch）",
  "affectedFiles": ["需要修改的文件列表"],
  "risks": ["可能的副作用或风险"]
}

只输出 JSON，不要 Markdown 包裹。`;

  let raw = '';
  try {
    raw = await client.chat(prompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return raw.slice(0, 500);
    const parsed = JSON.parse(jsonMatch[0]);
    return [
      `**根因:** ${parsed.rootCause ?? '未确定'} (置信度: ${((parsed.confidence ?? 0.5) * 100).toFixed(0)}%)`,
      `**修复方案:** ${parsed.fixDescription ?? '见 patch'}`,
      parsed.patch ? `**补丁:**\n\`\`\`diff\n${parsed.patch}\n\`\`\`` : '',
      parsed.affectedFiles?.length ? `**影响文件:** ${parsed.affectedFiles.join(', ')}` : '',
      parsed.risks?.length ? `**风险:** ${parsed.risks.join('; ')}` : '',
    ].filter(Boolean).join('\n\n');
  } catch {
    return raw.slice(0, 500);
  }
}

// ═══ Main Pipeline ═══

export async function runRepairPipeline(
  options: RepairPipelineOptions,
): Promise<RepairResult> {
  const start = Date.now();
  const { workingDir, taskDescription, mode, errorContext, proClient, flashClient, onProgress } = options;
  const tick = () => new Promise(r => setTimeout(r, 0));

  const filesExamined: string[] = [];
  const fileSnippets = new Map<string, string | null>();

  // Step 1: 项目上下文
  onProgress?.('🔍 扫描项目...');
  await tick();
  const repoInfo = await scanRepo({ workingDir }).catch(() => null);

  // Step 2: 解析错误
  onProgress?.('🔬 解析错误信息...');
  await tick();
  let errors: ParsedError[] = [];
  const errorSource = errorContext || taskDescription;
  errors = parseErrors(errorSource);

  // 如果错误解析没有提取到文件，从任务描述中提取
  if (errors.every((e) => !e.file)) {
    const taskFiles = extractFilesFromTask(taskDescription);
    for (const f of taskFiles) {
      errors.push({
        file: f, message: `任务描述中提到的文件: ${f}`,
        category: 'unknown', raw: taskDescription,
      });
    }
  }

  // Step 3: 定位并读取相关文件
  for (const e of errors) {
    if (e.file) {
      const fullPath = path.resolve(workingDir, e.file);
      if (fs.existsSync(fullPath) && !filesExamined.includes(e.file)) {
        filesExamined.push(e.file);
        fileSnippets.set(e.file, readFileSnippet(fullPath, e.line));
      } else if (!fs.existsSync(fullPath)) {
        // 尝试在项目中搜索这个文件
        try {
          const found = findFile(workingDir, path.basename(e.file));
          if (found && !filesExamined.includes(found)) {
            filesExamined.push(found);
            fileSnippets.set(found, readFileSnippet(path.resolve(workingDir, found), e.line));
          }
        } catch { /* ignore */ }
      }
    }
  }

  // 如果还没找到文件，从任务描述中提取并搜索
  if (filesExamined.length === 0) {
    const taskFiles = extractFilesFromTask(taskDescription);
    for (const f of taskFiles) {
      const fullPath = path.resolve(workingDir, f);
      if (fs.existsSync(fullPath) && !filesExamined.includes(f)) {
        filesExamined.push(f);
        fileSnippets.set(f, readFileSnippet(fullPath));
      }
    }
  }

  // Step 4: 根因分析
  onProgress?.('🧠 根因分析...');
  await tick();
  let rootCause: string | undefined;
  let rootCauseConfidence = 0;
  let suggestedFix: string | undefined;

  // 先用模式匹配做快速分析
  const patternCause = analyzeRootCausePattern(errors, fileSnippets);
  if (patternCause) {
    rootCause = patternCause;
    rootCauseConfidence = 0.7;
  }

  // 如果有 Pro 模型，做深度分析
  if (proClient && errors.length > 0 && filesExamined.length > 0) {
    try {
      const proResult = await proAnalyze(errors, fileSnippets, taskDescription, repoInfo, proClient);
      rootCause = proResult;
      rootCauseConfidence = 0.9;
    } catch {
      // Pro 分析失败，使用模式匹配结果
    }
  } else if (flashClient && errors.length > 0 && filesExamined.length > 0) {
    // Fallback to Flash for lighter analysis
    try {
      const flashResult = await proAnalyze(errors, fileSnippets, taskDescription, repoInfo, flashClient);
      if (!rootCause) {
        rootCause = flashResult;
        rootCauseConfidence = 0.6;
      }
    } catch { /* ignore */ }
  }

  // Step 5: 生成修复建议
  if (mode === 'readonly') {
    const errorList = errors.length > 0
      ? `\n检测到 ${errors.length} 个错误:\n${errors.map((e) => `  • ${e.file ? `${e.file}:${e.line ?? '?'} ` : ''}${e.message.slice(0, 100)}`).join('\n')}`
      : '';
    suggestedFix = `[只读模式] 当前仅输出修复建议，不会修改文件。切换到 --write 模式可以自动应用补丁。${errorList}`;
  } else {
    suggestedFix = rootCause
      ? `[读写模式] 根因已分析，请确认是否应用修复补丁。`
      : `[读写模式] 已分析 ${filesExamined.length} 个文件${errors.length > 0 ? `，${errors.length} 个错误` : ''}。`;
  }

  // Step 6: 构建结果
  const summary = [
    `🔧 Repair Pipeline 完成`,
    `分析文件: ${filesExamined.length} 个`,
    errors.length > 0 ? `解析错误: ${errors.length} 个` : '',
    rootCause ? `根因已确定 (置信度: ${(rootCauseConfidence * 100).toFixed(0)}%)` : '根因未确定，需更多信息',
  ].filter(Boolean).join(' | ');

  // 修补补丁生成：当前只做错误定位+根因分析，不自动生成补丁。
  // 自动补丁需要验证闭环（生成→应用→typecheck→回滚），在完成前返回 undefined 比返回假补丁更安全。
  // 用户可在只读模式看到诊断结论，通过 --write + autofix 走完整闭环后再产出可用补丁。
  let patchProposal: string | undefined;

  // 空分析判定: 文件0+根因空 → 不是成功, 不要显示"完成"
  const actuallyAnalyzed = filesExamined.length > 0 || !!rootCause;
  const result: RepairResult = {
    success: actuallyAnalyzed,
    summary: actuallyAnalyzed ? summary : '无法定位问题。建议提供更具体的错误信息或文件路径重试。',
    filesExamined,
    rootCause,
    rootCauseConfidence,
    patchProposal,
    suggestedFix,
    errorLocation: errors[0],
    elapsedMs: Date.now() - start,
  };

  return result;
}

/** 在项目中搜索文件 */
function findFile(dir: string, name: string): string | null {
  try {
    const walk = (d: string, depth: number): string | null => {
      if (depth > 5) return null;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          const found = walk(full, depth + 1);
          if (found) return found;
        } else if (e.name === name) {
          return path.relative(dir, full);
        }
      }
      return null;
    };
    return walk(dir, 0);
  } catch {
    return null;
  }
}

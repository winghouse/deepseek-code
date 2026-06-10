// ============================================================
// PromptBuilder — 四层稳定前缀结构
// 原理：DeepSeek Context Caching 匹配 overlapping prefix
//      前缀越稳定 → 缓存命中率越高
// ============================================================

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoInfo, ExecutionPlan, Session } from 'deepseek-code-shared';

export interface PromptLayers {
  globalPrefix: string;
  runtimePrefix: string;
  projectPrefix: string;
  sessionPrefix: string;
  dynamicTail: string;
}

export interface PromptHashes {
  globalPrefixHash: string;
  runtimePrefixHash: string;
  projectPrefixHash: string;
  sessionPrefixHash: string;
  dynamicTailHash: string;
}

// ═══════════════════════════════════════════════
// Layer 1: Global Stable Prefix
// 所有项目、所有 session 完全一致
// ═══════════════════════════════════════════════

export function buildGlobalPrefix(): string {
  return stableJoin('\n', [
    '你是 DeepSeek Code Agent，一个 AI 编程助手，运行在终端 CLI 中。',
    '',
    '## 你的身份',
    '- 你由 DeepSeek 提供支持，当前运行的是 DeepSeek V4 系列模型',
    '- 你不知道自己具体是哪个模型版本，不要猜测或声称模型名称（如 deepseek-chat/deepseek-reasoner 等旧称）',
    '- 如果被问及"你是什么模型"，诚实地回答"DeepSeek Code Agent，由 DeepSeek V4 驱动，具体版本请查阅项目文档"',
    '',
    '## 工具协议',
    '你可以调用以下工具来读取文件、搜索代码、运行命令：',
    '- read_file(path, startLine?, endLine?) — 读取文件内容',
    '- write_file(path, content) — 写入文件（需权限）',
    '- search_code(pattern, fileTypes?, directory?) — 搜索代码',
    '- list_files(directory?, depth?) — 列出目录',
    '- glob(directory?, depth?) — list_files 别名',
    '- git_status() — Git 状态',
    '- git_diff(staged?, file?) — Git 差异',
    '- read_package_json() — 读取 package.json',
    '- read_project_rules() — 读取项目规则',
    '- apply_patch(patch, filesAffected) — 应用补丁（需权限）',
    '- run_command(command, cwd?) — 执行命令（需权限）',
    '',
    '## 安全规则',
    '- 禁止修改 .env 等敏感文件',
    '- 禁止执行 rm -rf /、curl | bash 等危险命令',
    '- 写文件和执行命令前必须确认',
    '',
    '## 输出格式',
    '- 使用 Markdown 格式',
    '- 代码块标注语言',
    '- 引用文件时使用 路径:行号 格式',
  ]);

}

// ═══════════════════════════════════════════════
// Layer 2: Runtime Stable Prefix
// 同机器同项目内稳定（OS/Shell/Workspace）
// ═══════════════════════════════════════════════

export function buildRuntimePrefix(): string {
  return stableJoin('\n', [
    '## 运行环境',
    `OS: ${process.platform}`,
    `Shell: ${process.env.SHELL ?? 'cmd'}`,
    `工作区: ${process.cwd()}`,
    '不要使用 /Users/、/home/、他人绝对路径。',
    '仅使用工作区相对路径。',
  ]);
}

// ═══════════════════════════════════════════════
// Layer 3: Project Stable Prefix
// 同一 repo 内尽量稳定，基于 repo-context.md
// ═══════════════════════════════════════════════

export function buildProjectPrefix(repoInfo: RepoInfo): string {
  const ts = repoInfo.techStack;
  const st = repoInfo.structure;

  return stableJoin('\n', [
    '## 当前项目',
    `名称: ${repoInfo.name}`,
    `语言: ${ts.language}`,
    `框架: ${ts.framework ?? '无'}`,
    `构建: ${ts.buildTool}`,
    `包管理: ${ts.packageManager}`,
    `UI: ${ts.uiLibrary ?? '无'}`,
    `测试: ${ts.testFramework ?? '无'}`,
    '',
    '### 目录结构',
    ...(st.keyDirectories ?? []).sort().map((d) => `- ${d}/`),
    `入口: ${[...st.entryFiles].sort().join(', ')}`,
    '',
    '### 项目规则',
    // AGENTS.md 层级加载: root + packages/*
    (() => {
      const agents: string[] = [];
      if (repoInfo.rules.agentsMd) agents.push(`[AGENTS root]\n${repoInfo.rules.agentsMd}`);
      // 检查子目录
      try {
        const subDirs = fs.readdirSync(repoInfo.rootDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
        for (const d of subDirs) {
          const subPath = path.join(repoInfo.rootDir, d.name, 'AGENTS.md');
          if (fs.existsSync(subPath)) {
            agents.push(`[AGENTS ${d.name}]\n${fs.readFileSync(subPath, 'utf-8').slice(0, 2000)}`);
          }
        }
      } catch { /* ignore */ }
      return agents.length > 0 ? agents.join('\n\n') : 'AGENTS.md: 无';
    })(),
    repoInfo.rules.readme ? `README:\n${repoInfo.rules.readme}` : 'README: 无',
    '',
    repoInfo.git
      ? `Git: 分支 ${repoInfo.git.branch}, 有未提交改动: ${repoInfo.git.hasUncommittedChanges ? '是' : '否'}`
      : 'Git: 非仓库',
  ]);
}

// ═══════════════════════════════════════════════
// Layer 4: Session Stable Prefix
// 同一 session 内稳定
// ═══════════════════════════════════════════════

export function buildSessionPrefix(
  task: string,
  plan: ExecutionPlan | null,
  phase: string,
  mode: string,
): string {
  // 注意: knownFiles 已移到 Dynamic Tail，避免每轮变化破坏 Session KV Cache
  return stableJoin('\n', [
    `## 任务: ${task}`,
    `阶段: ${phase}`,
    `模式: ${mode}`,
    '',
    plan ? `## 计划\n${formatPlanStable(plan)}` : '',
  ]);
}

function formatPlanStable(plan: ExecutionPlan): string {
  return [...plan.steps]
    .sort((a, b) => a.order - b.order)
    .map((s) => `${s.order}. [${s.action}] ${s.description}`)
    .join('\n');
}

// ═══════════════════════════════════════════════
// Layer 5: Dynamic Tail
// 每轮请求变化的内容，必须放在最后
// ═══════════════════════════════════════════════

export function buildDynamicTail(
  userInput: string,
  toolResults?: string,
  errors?: string,
  gitDiff?: string,
  knownFiles?: string[],
): string {
  return stableJoin('\n', [
    `## 当前输入\n${userInput}`,
    knownFiles && knownFiles.length > 0
      ? `## 已知文件\n${[...knownFiles].sort().map((f) => `- ${f}`).join('\n')}`
      : '',
    toolResults ? `## 工具结果\n${toolResults}` : '',
    errors ? `## 报错\n${errors}` : '',
    gitDiff ? `## Git Diff\n${gitDiff}` : '',
  ]);
}

// ═══════════════════════════════════════════════
// 主入口：构建完整 prompt
// ═══════════════════════════════════════════════

export function buildPrompt(params: {
  repoInfo: RepoInfo;
  task: string;
  plan: ExecutionPlan | null;
  phase: string;
  knownFiles: string[];
  mode: string;
  userInput: string;
  toolResults?: string;
  errors?: string;
  gitDiff?: string;
}): { layers: PromptLayers; hashes: PromptHashes } {
  const globalPrefix = buildGlobalPrefix();
  const runtimePrefix = buildRuntimePrefix();
  const projectPrefix = buildProjectPrefix(params.repoInfo);
  const sessionPrefix = buildSessionPrefix(
    params.task, params.plan, params.phase, params.mode,
  );
  const dynamicTail = buildDynamicTail(
    params.userInput, params.toolResults, params.errors, params.gitDiff, params.knownFiles,
  );

  return {
    layers: { globalPrefix, runtimePrefix, projectPrefix, sessionPrefix, dynamicTail },
    hashes: {
      globalPrefixHash: shortHash(globalPrefix),
      runtimePrefixHash: shortHash(runtimePrefix),
      projectPrefixHash: shortHash(projectPrefix),
      sessionPrefixHash: shortHash(sessionPrefix),
      dynamicTailHash: shortHash(dynamicTail),
    },
  };
}

// ═══════════════════════════════════════════════
// resume 历史压缩：不要全量消息回放
// ═══════════════════════════════════════════════

export function compressSessionForResume(session: Session): {
  task: string;
  plan: ExecutionPlan | null;
  phase: string;
  knownFiles: string[];
  appliedPatches: string[];
  lastFindings: string;
  recentToolResults: string;
} {
  const toolSteps = session.steps.filter((s) => s.type === 'tool_call');
  const lastFinal = [...session.steps].reverse().find((s) => s.type === 'final');

  // 最近 3 轮工具结果保留完整内容（模型需要上下文决策）
  const recentSteps = toolSteps.slice(-3);
  const recentToolResults = recentSteps
    .flatMap((s) => s.toolResults ?? [])
    .map((r) => r.content)
    .filter(Boolean)
    .join('\n---\n');

  return {
    task: session.taskDescription,
    plan: session.plan ?? null,
    phase: session.phase ?? 'analyzing',
    knownFiles: session.knownFiles ?? [],
    appliedPatches: session.appliedPatches ?? [],
    lastFindings: lastFinal?.content ?? '',
    recentToolResults,
  };
}

// ═══════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════

/** 稳定拼接：过滤空值，保持顺序 */
function stableJoin(sep: string, parts: string[]): string {
  return parts.filter((p) => p !== '' && p != null).join(sep);
}

/** MD5 短 hash（用于日志） */
function shortHash(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 8);
}

/** 稳定 JSON stringify：递归 key 排序 */
export function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return '{' + keys.map((k) => `"${k}":${stableStringify((obj as Record<string, unknown>)[k])}`).join(',') + '}';
}

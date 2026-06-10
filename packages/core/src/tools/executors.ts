// ============================================================
// Tool Layer — 工具执行器
// ============================================================

import { execa } from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolExecutionResult } from 'deepseek-code-shared';
import { isSensitiveFile, truncate, fileFingerprint } from 'deepseek-code-shared';
import { executeWebSearch, formatWebSearchResult, executeWebFetch } from './web-search.js';
import { applyUnifiedDiff, applySearchReplace, extractFilesFromPatch, rollbackApplied, extractNewFileContent } from './diff-utils.js';
import type { WebSearchResultItem } from 'deepseek-code-shared';

/** 工具执行上下文 */
export interface ToolContext {
  workingDir: string;
  /** 当前模式 */
  mode?: 'readonly' | 'ask' | 'auto';
  /** 允许的工具列表（空 = 全部允许） */
  allowedTools?: string[];
  /** 工具失败计数 */
  failureBudget?: ToolFailureBudget;
  overrides?: Partial<ToolExecutors>;
  toolCache?: Map<string, import('deepseek-code-shared').ToolExecutionResult>;
  isResume?: boolean;
}

export interface ToolFailureBudget {
  toolFailures: Map<string, number>;     // 每个工具的连续失败次数
  totalFailures: number;
  blockedTools: Set<string>;             // 已被熔断禁用的工具
  maxConsecutiveFailures: number;        // 同工具最大连续失败次数 (default 2)
  maxTotalFailures: number;              // 总失败次数上限 (default 5)
}

export function createFailureBudget(): ToolFailureBudget {
  return {
    toolFailures: new Map(),
    totalFailures: 0,
    blockedTools: new Set(),
    maxConsecutiveFailures: 2,
    maxTotalFailures: 5,
  };
}

/** 生成缓存 key */
function cacheKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(args)}`;
}

export interface ToolExecutors {
  // 只读
  listFiles: (args: { directory?: string; depth?: number }) => Promise<ToolExecutionResult>;
  readFile: (args: {
    filePath: string;
    startLine?: number;
    endLine?: number;
  }) => Promise<ToolExecutionResult>;
  readFileBatch: (args: {
    filePaths: string[];
    maxLinesPerFile?: number;
  }) => Promise<ToolExecutionResult>;
  searchCode: (args: {
    pattern: string;
    fileTypes?: string;
    directory?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  }) => Promise<ToolExecutionResult>;
  webSearch: (args: {
    query: string;
    site?: string;
    contextSize?: 'low' | 'medium' | 'high';
    maxResults?: number;
  }) => Promise<ToolExecutionResult>;
  webFetch: (args: {
    url: string;
    maxChars?: number;
    maxPages?: number;
    format?: 'text' | 'markdown';
  }) => Promise<ToolExecutionResult>;
  gitStatus: () => Promise<ToolExecutionResult>;
  gitDiff: (args: { staged?: boolean; file?: string }) => Promise<ToolExecutionResult>;
  readPackageJson: () => Promise<ToolExecutionResult>;
  readProjectRules: () => Promise<ToolExecutionResult>;
  // 写操作
  applyPatch: (args: { patch: string; filesAffected?: string[] }) => Promise<ToolExecutionResult>;
  runCommand: (args: { command: string; cwd?: string }) => Promise<ToolExecutionResult>;
  runCmd: (args: { executable: string; args: string[]; cwd?: string; reason?: string }) => Promise<ToolExecutionResult>;
  writeFile: (args: { filePath: string; content: string }) => Promise<ToolExecutionResult>;
}

/**
 * 创建默认工具执行器
 */
export function createToolExecutors(ctx: ToolContext): ToolExecutors {
  const { workingDir, toolCache } = ctx;

  const resolve = (p: string) => path.resolve(workingDir, p);

  /** 安全路径解析：拒绝工作区外路径 */
  function resolveSafe(p: string): string {
    const full = path.resolve(workingDir, p);
    // 规范化后检查：必须在 workingDir 内
    const rel = path.relative(workingDir, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`路径穿越拒绝: "${p}" 不在工作区 "${workingDir}" 内`);
    }
    return full;
  }

  /** 过滤敏感环境变量 */
  function safeEnv(): Record<string, string> {
    const allow = ['PATH', 'HOME', 'USER', 'USERNAME', 'SHELL', 'NODE_ENV', 'PNPM_HOME', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'TERM'];
    const env: Record<string, string> = {};
    for (const key of allow) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    return env;
  }

  /** 检查并返回缓存 */
  function checkCache(name: string, args: Record<string, unknown>): ToolExecutionResult | null {
    if (!toolCache) return null;
    const key = cacheKey(name, args);
    const cached = toolCache.get(key);
    if (cached) {
      if (ctx.isResume) console.log(`  💾 缓存命中: ${name}`);
      return cached;
    }
    return null;
  }

  /** 写入缓存 */
  function setCache(name: string, args: Record<string, unknown>, result: ToolExecutionResult): void {
    if (!toolCache) return;
    toolCache.set(cacheKey(name, args), result);
  }

  return {
    // ---- 只读工具 ----

    async listFiles({ directory, depth = 2 }) {
      try {
        const target = directory ? resolveSafe(directory) : workingDir;
        if (!fs.existsSync(target)) {
          return { success: false, content: `目录不存在: ${target}` };
        }

        const result = walkDir(target, depth, workingDir);
        return { success: true, content: result };
      } catch (e) {
        return { success: false, content: '', error: String(e) };
      }
    },

    async readFile({ filePath, startLine, endLine }) {
      try {
        // 检查缓存（基于文件指纹，文件未变则复用）
        const fp = fileFingerprint(resolve(filePath));
        const cacheKey = `read:${filePath}:${fp}`;
        if (toolCache) {
          const cached = toolCache.get(cacheKey);
          if (cached) {
            if (ctx.isResume) console.log(`  💾 缓存命中: read_file "${filePath}"`);
            return cached;
          }
        }
        const fullPath = resolveSafe(filePath);
        if (!fs.existsSync(fullPath)) {
          return { success: false, content: `文件不存在: ${filePath}。请先用 list_files 或 glob 查看目录内容。` };
        }
        if (fs.statSync(fullPath).isDirectory()) {
          return { success: false, content: `${filePath} 是目录，不是文件。请用 list_files 或 glob 列出其内容。` };
        }

        // 安全检查：敏感文件只返回摘要
        if (isSensitiveFile(filePath)) {
          return {
            success: true,
            content: `[敏感文件] ${filePath} — 出于安全考虑，不返回全文。文件存在，共 ${fs.statSync(fullPath).size} 字节。`,
          };
        }

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');

        const start = Math.max(1, startLine ?? 1) - 1;
        const end = Math.min(lines.length, endLine ?? lines.length);

        const selected = lines
          .slice(start, end)
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join('\n');

        // 大文件提醒：超过 500 行且未指定范围时，建议用 read_file_range
        const isFullRead = !startLine && !endLine;
        const warning = (isFullRead && lines.length > 500)
          ? `⚠️ 文件共 ${lines.length} 行。建议使用 read_file_range 分段读取以减少上下文用量。\n\n`
          : '';

        const result = {
          success: true as const,
          content: warning + truncate(selected, 50_000),
          metadata: { totalLines: lines.length, shownLines: end - start, suggestRange: isFullRead && lines.length > 500 },
        };
        // 写入缓存
        if (toolCache) toolCache.set(cacheKey, result);
        return result;
      } catch (e) {
        return { success: false, content: '', error: String(e) };
      }
    },

    // DeepSeek V4 1M 上下文：批量读取文件，一次加载多个文件
    async readFileBatch({ filePaths, maxLinesPerFile = 200 }) {
      const results: string[] = [];
      const errors: string[] = [];
      const files = filePaths.slice(0, 20); // 最多 20 个文件

      for (const fp of files) {
        try {
          const fullPath = resolveSafe(fp);
          if (!fs.existsSync(fullPath)) { errors.push(`${fp}: 不存在`); continue; }
          if (isSensitiveFile(fp)) { results.push(`[敏感文件] ${fp}`); continue; }
          const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
          const preview = lines.slice(0, maxLinesPerFile);
          const ctx = `### ${fp} (${preview.length}/${lines.length} 行)\n\`\`\`\n${preview.join('\n')}\n\`\`\``;
          results.push(ctx);
        } catch (e) {
          errors.push(`${fp}: ${String(e)}`);
        }
      }

      const summary = results.length > 0
        ? `📦 批量读取 ${results.length} 个文件 (${maxLinesPerFile} 行/文件, DeepSeek V4 1M 上下文):\n\n` + results.join('\n\n')
        : '';
      const errPart = errors.length > 0 ? `\n\n⚠️ ${errors.length} 个文件读取失败:\n${errors.join('\n')}` : '';

      return {
        success: results.length > 0,
        content: summary + errPart,
        metadata: { filesRead: results.length, filesFailed: errors.length, totalLines: results.reduce((s, r) => s + (r.split('\n').length || 0), 0) },
      };
    },

    async searchCode({ pattern, fileTypes, directory, caseSensitive = false, maxResults = 50 }) {
      try {
        // 默认排除目录
        const excludeDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.deepseek-code'];
        const args = ['--no-heading', '-n', '--max-count', String(maxResults)];

        if (!caseSensitive) args.push('-i');
        if (fileTypes) args.push('--type-add', `custom:${fileTypes}`, '--type', 'custom');
        for (const d of excludeDirs) args.push('--glob', `!${d}/**`, '--glob', `!${d}`);

        // 检测复杂正则：含 | ( ) [ ] { } 等 → 降级为简单文本搜索，避免 ripgrep 超时
        const complexRegex = /[|()[\]{}*+?^$]/.test(pattern) && pattern.length > 10;
        const cwd = directory ? resolve(directory) : workingDir;

        try {
          const result = await execa('rg', args, { cwd, timeout: complexRegex ? 2000 : 5_000, reject: false });
          if (result.timedOut) {
            const tip = complexRegex
              ? `搜索超时。你的模式 "${pattern.slice(0, 40)}" 使用了正则语法，ripgrep 搜索太慢。请：1) 只用简单关键词搜索 2) 多个关键词分多次 search_code 搜索 3) 指定具体 directory 缩小范围`
              : `搜索超时 (5s)。建议: 指定 directory 缩小目录、添加 fileTypes 过滤文件类型、或简化搜索模式`;
            return { success: false, content: tip, error: 'timeout' };
          }
          const content = result.stdout;
          if (!content) {
            return {
              success: true,
              content: `在 ${cwd} 中未找到匹配 "${pattern}" 的结果。建议: 1) 简化搜索模式 2) 扩大文件类型 3) 换个关键词`,
            };
          }
          return { success: true, content: truncate(content, 20_000) };
        } catch {
          // ripgrep 不可用时降级到 grep
          const result = await execa(
            'grep',
            ['-rn', caseSensitive ? '' : '-i', '--include', fileTypes ?? '*', pattern, '.'],
            { cwd, timeout: 30_000, reject: false },
          );
          return { success: true, content: truncate(result.stdout || '未找到匹配结果', 20_000) };
        }
      } catch (e) {
        return { success: false, content: `搜索失败: ${e}` };
      }
    },

    async webSearch(args) {
      const result = await executeWebSearch(args.query, {
        site: args.site,
        contextSize: args.contextSize ?? 'medium',
        maxResults: args.maxResults ?? 10,
      });
      return {
        success: result.success,
        content: formatWebSearchResult(result),
        metadata: {
          query: result.query,
          totalResults: result.totalEstimated,
          source: result.source,
          elapsedMs: result.elapsedMs,
          results: result.results.map((r: WebSearchResultItem) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet.slice(0, 200),
          })),
        },
      };
    },

    async webFetch(args) {
      const result = await executeWebFetch(args.url, {
        maxChars: args.maxChars ?? 5000,
        maxPages: args.maxPages ?? 1,
        format: args.format ?? 'text',
      });
      return {
        success: result.success,
        content: result.success
          ? `📄 **${result.title ?? args.url}**\n\n${result.content}\n\n---\n${result.contentLength} 字符 | ${(result.elapsedMs / 1000).toFixed(1)}s`
          : `❌ 获取失败: ${result.error ?? '未知错误'}`,
        metadata: {
          url: result.url,
          title: result.title,
          contentLength: result.contentLength,
          elapsedMs: result.elapsedMs,
        },
      };
    },

    async gitStatus() {
      try {
        const branch = await execa('git', ['branch', '--show-current'], {
          cwd: workingDir,
          timeout: 10_000,
          reject: false,
        });
        const status = await execa('git', ['status', '--short'], {
          cwd: workingDir,
          timeout: 10_000,
          reject: false,
        });

        const hasChanges = status.stdout.trim().length > 0;
        const changedFiles = status.stdout.trim().split('\n').filter(Boolean).length;
        return {
          success: true,
          content: [
            `分支: ${branch.stdout.trim() || '未知'}`,
            `变更:\n${status.stdout || '工作区干净'}`,
          ].join('\n'),
          metadata: {
            branch: branch.stdout.trim() || 'unknown',
            hasUncommittedChanges: hasChanges,
            changedFiles,
          },
        };
      } catch {
        return { success: false, content: '不是 Git 仓库或 Git 不可用' };
      }
    },

    async gitDiff({ staged = false, file } = {}) {
      try {
        const args = ['diff'];
        if (staged) args.push('--staged');
        if (file) args.push('--', file);

        const result = await execa('git', args, {
          cwd: workingDir,
          timeout: 15_000,
          reject: false,
        });

        const content = result.stdout || '无差异';
        const hasChanges = result.stdout.trim().length > 0;
        return {
          success: true,
          content: truncate(content, 30_000),
          metadata: { hasChanges, length: result.stdout.length },
        };
      } catch {
        return { success: false, content: '无法获取 git diff' };
      }
    },

    async readPackageJson() {
      try {
        const pkgPath = resolve('package.json');
        if (!fs.existsSync(pkgPath)) {
          return { success: false, content: '未找到 package.json' };
        }
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const summary = {
          name: pkg.name,
          version: pkg.version,
          scripts: Object.keys(pkg.scripts ?? {}),
          dependencies: Object.keys(pkg.dependencies ?? {}),
          devDependencies: Object.keys(pkg.devDependencies ?? {}),
        };
        return { success: true, content: JSON.stringify(summary, null, 2) };
      } catch (e) {
        return { success: false, content: `读取 package.json 失败: ${e}` };
      }
    },

    async readProjectRules() {
      try {
        const ruleFiles = [
          'AGENTS.md',
          'CLAUDE.md',
          '.cursorrules',
          '.github/copilot-instructions.md',
        ];

        const found: Record<string, string> = {};
        for (const file of ruleFiles) {
          const fullPath = resolve(file);
          if (fs.existsSync(fullPath)) {
            found[file] = fs.readFileSync(fullPath, 'utf-8').slice(0, 3000); // 截断
          }
        }

        if (Object.keys(found).length === 0) {
          return { success: true, content: '未找到项目规则文件。建议创建 AGENTS.md 来描述项目规范。' };
        }

        const content = Object.entries(found)
          .map(([file, text]) => `--- ${file} ---\n${text}`)
          .join('\n\n');
        return { success: true, content };
      } catch (e) {
        return { success: false, content: `读取项目规则失败: ${e}` };
      }
    },

    // ---- 写工具 ----

    async applyPatch({ patch: patchContent, filesAffected }) {
      const results: string[] = [];
      const backupDir = path.join(workingDir, '.deepseek-code', 'backups');
      fs.mkdirSync(backupDir, { recursive: true });

      const files = Array.isArray(filesAffected) ? filesAffected : [];
      if (files.length === 0 && patchContent) {
        const extracted = extractFilesFromPatch(patchContent);
        if (extracted.length > 0) files.push(...extracted);
      }
      if (files.length === 0) {
        return { success: false, content: '❌ apply_patch 缺少 filesAffected 参数' };
      }

      type RollbackEntry = { file: string; backup?: string; original?: string; isNew: boolean };
      const rollbackLog: RollbackEntry[] = [];

      for (const file of files) {
        try {
          const fullPath = resolveSafe(file);
          const isNewFile = !fs.existsSync(fullPath);

          if (!isNewFile && isSensitiveFile(file)) {
            results.push(`🚫 ${file}: 禁止修改敏感文件`);
            continue;
          }

          const original = isNewFile ? '' : fs.readFileSync(fullPath, 'utf-8');
          let backupName = '';

          if (!isNewFile) {
            const backupPath = path.join(backupDir, `${file.replace(/[/\\]/g, '_')}.${Date.now()}.bak`);
            fs.writeFileSync(backupPath, original, 'utf-8');
            backupName = path.basename(backupPath);
            rollbackLog.push({ file, backup: backupPath, original, isNew: false });
          } else {
            rollbackLog.push({ file, isNew: true });
          }

          const patched = isNewFile
            ? extractNewFileContent(patchContent)
            : applyUnifiedDiff(original, patchContent, file);

          if (patched === null) {
            // 回滚所有已写入文件
            rollbackApplied(rollbackLog, workingDir);
            return { success: false, content: `⚠️ ${file}: diff 无法应用，已回滚 ${rollbackLog.length} 个文件`, metadata: { rolledBack: true } };
          }

          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, patched, 'utf-8');

          const origLines = isNewFile ? 0 : original.split('\n').length;
          const newLines = patched.split('\n').length;
          const status = isNewFile ? '🆕 新建' : `✅`;
          results.push(`${status} ${file}: +${Math.max(0, newLines - origLines)} -${Math.max(0, origLines - newLines)} 行${backupName ? ` (备份: ${backupName})` : ''}`);
        } catch (e) {
          rollbackApplied(rollbackLog, workingDir);
          return { success: false, content: `❌ ${file}: ${String(e)}。已回滚 ${rollbackLog.length} 个文件`, metadata: { rolledBack: true } };
        }
      }

      return {
        success: results.some((r) => r.startsWith('✅') || r.startsWith('🆕')),
        content: results.join('\n'),
        metadata: { filesAffected: files, backupDir },
      };
    },

    async runCmd({ executable, args: cmdArgs, cwd, reason: _reason }) {
      // 安全白名单：移除 node/npx（可执行任意代码）
      const SAFE_EXECUTABLES = new Set(['pnpm', 'npm', 'git', 'tsc', 'vitest', 'yarn']);
      if (!SAFE_EXECUTABLES.has(executable)) {
        return { success: false, content: `❌ 不可执行: ${executable}。允许: ${[...SAFE_EXECUTABLES].join(', ')}`, error: 'UNSAFE_EXECUTABLE' };
      }
      const targetDir = cwd ? resolveSafe(cwd) : workingDir;
      // 直接用 execa，不经过 shell
      try {
        const result = await execa(executable, cmdArgs, {
          cwd: targetDir,
          shell: false,
          timeout: 60_000,
          reject: false,
          env: safeEnv(),
        });
        if (result.exitCode !== 0) {
          return {
            success: false,
            content: `[stderr]\n${result.stderr?.slice(0, 5000) ?? ''}\n[exit: ${result.exitCode}]`,
            error: `exit_code_${result.exitCode}`,
            metadata: { ok: false, error: `exit_code_${result.exitCode}`, message: result.stderr?.slice(0, 200) ?? '', command: `${executable} ${cmdArgs.join(' ')}`, cwd: targetDir },
          };
        }
        return {
          success: true,
          content: result.stdout ? `[stdout]\n${truncate(result.stdout, 10_000)}` : '(无输出)',
          metadata: { exitCode: 0, cwd: targetDir },
        };
      } catch (e: unknown) {
        const err = e as Error & { code?: string };
        return { success: false, content: '', error: err.code ?? 'COMMAND_ERROR', metadata: { ok: false, message: err.message ?? '', command: executable, cwd: targetDir } };
      }
    },

    async runCommand({ command, cwd }) {
      // 已废弃，全部转发到 runCmd（安全：shell:false，可执行文件白名单）
      const parts = command.trim().split(/\s+/);
      if (parts.length > 0) {
        return this.runCmd({ executable: parts[0], args: parts.slice(1), cwd, reason: "legacy run_command" });
      }
      return {
        success: false, content: "", error: "INVALID_COMMAND",
        metadata: { message: "run_command 已废弃，请使用 run_cmd 并提供 executable + args 数组", command },
      };
    },

    async writeFile({ filePath, content }) {
      try {
        const fullPath = resolveSafe(filePath);

        // 安全检查
        if (isSensitiveFile(filePath)) {
          return { success: false, content: `🚫 禁止修改敏感文件: ${filePath}` };
        }

        // 备份原文件（如果存在）
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });

        if (fs.existsSync(fullPath)) {
          const backupDir = path.join(workingDir, '.deepseek-code', 'backups');
          fs.mkdirSync(backupDir, { recursive: true });
          const backupPath = path.join(backupDir, `${filePath.replace(/[/\\]/g, '_')}.${Date.now()}.bak`);
          fs.copyFileSync(fullPath, backupPath);
        }

        fs.writeFileSync(fullPath, content, 'utf-8');

        const lines = content.split('\n').length;
        return {
          success: true,
          content: `✅ 已写入 ${filePath} (${lines} 行)`,
          metadata: { filePath, lines },
        };
      } catch (e) {
        return {
          success: false,
          content: `写入文件失败: ${String(e)}`,
          error: String(e),
        };
      }
    },
  };
}

/**
 * 根据工具名称分发执行（带权限检查 + 超时保护 + 熔断）
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  executors: ToolExecutors,
  ctx?: ToolContext,
): Promise<ToolExecutionResult> {
  // ═══ 熔断检查（最先执行，跟踪所有失败） ═══
  if (ctx?.failureBudget) {
    const fb = ctx.failureBudget;
    if (fb.blockedTools.has(name)) {
      return {
        success: false,
        content: '',
        error: 'TOOL_CIRCUIT_BROKEN',
        metadata: { message: `${name} 已被熔断禁用，不要再调用。`, blocked: true },
      };
    }
    if (fb.totalFailures >= fb.maxTotalFailures) {
      return {
        success: false,
        content: '',
        error: 'FAILURE_BUDGET_EXCEEDED',
        metadata: { message: `工具失败次数已达上限 (${fb.maxTotalFailures})，任务终止。`, blocked: true },
      };
    }
  }

  // ═══ 权限检查 ═══
  const writeTools = new Set(['apply_patch', 'write_file', 'run_command']);
  const isWrite = writeTools.has(name);

  if (ctx?.mode === 'readonly' && isWrite) {
    const blockedResult: ToolExecutionResult = {
      success: false,
      content: `当前是只读模式，无法执行 ${name}。告诉用户：这个操作需要写权限，输入 /write 切换到读写模式后就可以执行了。不要说你"没有能力"——你有能力，只是需要用户授权。`,
      error: 'READONLY_TOOL_BLOCKED',
      metadata: {
        message: `需要写权限。引导用户使用 /write 切换模式。`,
        blocked: true,
        doNotRetry: true,
      },
    };
    // 仍然计入熔断
    trackFailure(name, blockedResult, ctx);
    return blockedResult;
  }

  if (ctx?.allowedTools && ctx.allowedTools.length > 0 && !ctx.allowedTools.includes(name)) {
    return {
      success: false,
      content: '',
      error: 'TOOL_NOT_ALLOWED',
      metadata: {
        message: `${name} 不在当前允许的工具列表中。可用工具: ${ctx.allowedTools.join(', ')}`,
        blocked: true,
      },
    };
  }

  // ═══ 路径安全检查（run_command）═══
  if (name === 'run_command' && typeof args.command === 'string') {
    const cmd = args.command as string;
    if (hasExternalPath(cmd, ctx?.workingDir ?? process.cwd())) {
      return {
        success: false,
        content: '',
        error: 'COMMAND_OUTSIDE_WORKSPACE',
        metadata: {
          message: `命令包含工作区外路径。当前工作区: ${ctx?.workingDir ?? process.cwd()}。请使用相对路径。`,
          command: cmd,
          suggestion: '如需类型检查，请使用 pnpm typecheck 或 pnpm -C packages/core typecheck',
          blocked: true,
        },
      };
    }
  }

  const TIMEOUT = 30_000;
  const result = await Promise.race([
    executeToolInternal(name, args, executors),
    new Promise<ToolExecutionResult>((resolve) =>
      setTimeout(() => resolve({ success: false, content: `工具 ${name} 执行超时 (${TIMEOUT / 1000}s)`, error: 'timeout' }), TIMEOUT),
    ),
  ]);

  // ═══ 熔断更新 ═══
  trackFailure(name, result, ctx);

  return result;
}

function trackFailure(name: string, result: ToolExecutionResult, ctx?: ToolContext): void {
  if (!ctx?.failureBudget) return;
  const fb = ctx.failureBudget;
  if (!result.success) {
    // BLOCKED 和 FORBIDDEN 立即熔断
    if (result.error === 'READONLY_TOOL_BLOCKED' || result.error === 'COMMAND_OUTSIDE_WORKSPACE' || result.error === 'TOOL_NOT_ALLOWED') {
      fb.blockedTools.add(name);
      fb.totalFailures++;
      return;
    }
    // 非系统性错误（超时、搜索无结果、bad pattern）不参与熔断，给模型重试机会
    const SOFT_ERRORS = ['timeout', 'not_found', 'empty_result', 'invalid_pattern'];
    if (SOFT_ERRORS.includes(result.error ?? '')) return;
    const fails = (fb.toolFailures.get(name) ?? 0) + 1;
    fb.toolFailures.set(name, fails);
    fb.totalFailures++;
    if (fails >= fb.maxConsecutiveFailures) {
      fb.blockedTools.add(name);
    }
  } else {
    fb.toolFailures.delete(name);
  }
}

/** 检查命令是否包含工作区外路径 */
function hasExternalPath(command: string, workspaceRoot: string): boolean {
  const dangerous = [
    /\/Users\//i, /\/home\//i, /~(\/|$)/,
    /\/etc\//, /\/var\//, /\/tmp\//i,
    /cd\s+\/[a-z]/i, /cd\s+~(\/|$)/i,
  ];
  // Windows workspace 下出现 Unix 用户路径
  if (/[A-Z]:\\/i.test(workspaceRoot)) {
    dangerous.push(/\/Users\//i, /\/home\//i, /\/root\//);
  }
  return dangerous.some((p) => p.test(command));
}

async function executeToolInternal(
  name: string,
  args: Record<string, unknown>,
  executors: ToolExecutors,
): Promise<ToolExecutionResult> {
  switch (name) {
    case 'list_files':
    case 'glob':
      return executors.listFiles(args as { directory?: string; depth?: number });
    case 'read_file':
    case 'read_file_range':
      return executors.readFile(
        args as { filePath: string; startLine?: number; endLine?: number },
      );
    case 'read_file_batch':
      return executors.readFileBatch(
        args as { filePaths: string[]; maxLinesPerFile?: number },
      );
    case 'search_code':
      return executors.searchCode(
        args as {
          pattern: string;
          fileTypes?: string;
          directory?: string;
          caseSensitive?: boolean;
          maxResults?: number;
        },
      );
    case 'web_search':
      return executors.webSearch(
        args as { query: string; site?: string; contextSize?: 'low' | 'medium' | 'high'; maxResults?: number },
      );
    case 'web_fetch':
      return executors.webFetch(
        args as { url: string; maxChars?: number; maxPages?: number; format?: 'text' | 'markdown' },
      );
    case 'git_status':
      return executors.gitStatus();
    case 'git_diff':
      return executors.gitDiff(args as { staged?: boolean; file?: string });
    case 'read_package_json':
      return executors.readPackageJson();
    case 'read_project_rules':
      return executors.readProjectRules();
    case 'apply_patch':
      return executors.applyPatch(
        args as { patch: string; filesAffected: string[] },
      );
    case 'run_command':
      return executors.runCommand(args as { command: string; cwd?: string });
    case 'run_cmd':
      return executors.runCmd(args as { executable: string; args: string[]; cwd?: string; reason?: string });
    case 'write_file':
      return executors.writeFile(args as { filePath: string; content: string });
    default:
      return { success: false, content: `未知工具: ${name}` };
  }
}

// ---- 辅助函数 ----

function walkDir(dir: string, depth: number, root: string, prefix = ''): string {
  if (depth < 0) return '';
  if (!fs.existsSync(dir)) return '';

  const isRoot = dir === root;
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return '';

  const relPath = isRoot ? '.' : path.relative(root, dir);

  // 跳过不应显示的目录
  const skipDirs = new Set(['node_modules', '.git', '.deepseek-code', 'dist', '.next', 'build', '__pycache__']);
  const name = path.basename(dir);
  if (!isRoot && skipDirs.has(name)) {
    return `${prefix}[${name}/] (已忽略)\n`;
  }

  let result = '';
  if (!isRoot) {
    result += `${prefix}${name}/\n`;
  } else {
    result += `${relPath}/\n`;
  }

  if (depth === 0) return result;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = entries
      .filter((e) => e.isFile())
      .sort((a, b) => a.name.localeCompare(b.name));

    const childPrefix = isRoot ? prefix : prefix + '  ';

    // 限制显示数量
    const maxFiles = 30;
    const shownFiles = files.slice(0, maxFiles);
    for (const f of shownFiles) {
      result += `${childPrefix}📄 ${f.name}\n`;
    }
    if (files.length > maxFiles) {
      result += `${childPrefix}... 还有 ${files.length - maxFiles} 个文件\n`;
    }

    for (const d of dirs) {
      result += walkDir(path.join(dir, d.name), depth - 1, root, childPrefix);
    }
  } catch {
    // 权限不足时静默处理
  }

  return result;
}

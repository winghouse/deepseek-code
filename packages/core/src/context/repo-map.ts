// ============================================================
// Repo Map — 仓库级结构化地图
// 为 DeepSeek V4 1M 上下文优化：紧凑、结构化、可缓存
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

// ═══ Types ═══

export interface RepoMapOptions {
  workingDir: string;
  /** 最大映射深度 (目录层级) */
  maxDepth?: number;
  /** 是否解析 import 依赖图 */
  includeImports?: boolean;
  /** 是否提取关键导出 */
  includeExports?: boolean;
  /** 是否合并小文件内容 */
  includeFileContents?: boolean;
  /** 文件内容最大字符数 (单文件) */
  maxFileChars?: number;
}

export interface RepoMap {
  /** 项目根目录 */
  root: string;
  /** 生成时间 */
  generatedAt: string;
  /** 总文件数 */
  totalFiles: number;
  /** 总字符数 (估算) */
  totalChars: number;
  /** token 估算 (1 token ≈ 2 chars) */
  estimatedTokens: number;
  /** KV Cache 指纹 */
  fingerprint: string;
  /** 目录树 */
  tree: DirNode;
  /** 模块依赖图 */
  imports?: Record<string, string[]>;
  /** 关键导出 */
  exports?: Record<string, string[]>;
  /** 文件内容摘要 (可选) */
  fileContents?: Record<string, string>;
}

export interface DirNode {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  children?: DirNode[];
  /** 如果是文件: 该文件的 import 列表 */
  imports?: string[];
  /** 如果是文件: 关键导出 */
  exports?: string[];
  /** 如果是文件: 内容样本 (前 N 字符) */
  content?: string;
}

// ═══ Constants ═══

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.deepseek-code', 'dist', 'build',
  '.next', 'coverage', '__pycache__', '.venv', 'venv',
  '.cache', '.turbo', '.idea', '.vscode',
]);

const SKIP_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '*.lock', '*.log',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt',
  '.css', '.scss', '.html', '.yaml', '.yml', '.toml',
  '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h',
  '.sh', '.bash', '.zsh', '.gitignore', '.dockerignore',
  '.xml', '.svg',
]);

// ═══ Main ═══

/**
 * 生成仓库级结构化地图
 * 优化为 ~10-50K tokens，在 1M 上下文中占 < 5%
 */
export function generateRepoMap(options: RepoMapOptions): RepoMap {
  const { workingDir, maxDepth = 8, includeImports = true, includeExports = true, includeFileContents = false, maxFileChars = 200 } = options;
  const start = Date.now();

  // 1. 构建目录树 + 收集文件指纹
  const tree = walkDir(workingDir, workingDir, 0, maxDepth, includeFileContents, maxFileChars);
  const fingerprint = buildFingerprint(workingDir);

  // 2. 统计
  let totalFiles = 0;
  let totalChars = 0;
  countStats(tree, ref => { totalFiles++; totalChars += ref.size || 0; });

  // 3. 解析 import 图
  let imports: Record<string, string[]> | undefined;
  let exports: Record<string, string[]> | undefined;

  if (includeImports) {
    const importGraph = buildImportGraph(workingDir, tree);
    imports = importGraph.imports;
    exports = importGraph.exports;
  } else if (includeExports) {
    // 只提取导出，不建图
    exports = {};
    collectExports(tree, exports, workingDir);
  }

  // 4. 文件内容 (在 walkDir 中已收集)
  let fileContents: Record<string, string> | undefined;
  if (includeFileContents) {
    fileContents = {};
    collectFileContents(tree, fileContents, workingDir, workingDir);
  }

  return {
    root: workingDir,
    generatedAt: new Date().toISOString(),
    totalFiles,
    totalChars,
    estimatedTokens: Math.ceil(totalChars / 2),
    fingerprint,
    tree,
    imports,
    exports,
    fileContents,
  };
}

/**
 * 将 RepoMap 格式化为模型可读的文本
 * 目标: 紧凑、结构化、~10-50K tokens
 */
export function formatRepoMap(map: RepoMap): string {
  const lines: string[] = [];
  lines.push(`# 仓库地图: ${path.basename(map.root)}`);
  lines.push(`文件数: ${map.totalFiles} | token估算: ${map.estimatedTokens}`);
  lines.push('');

  // 目录树
  lines.push('## 目录结构');
  lines.push(formatTree(map.tree, '', true));
  lines.push('');

  // 关键导出
  if (map.exports && Object.keys(map.exports).length > 0) {
    lines.push('## 关键导出');
    for (const [file, exps] of Object.entries(map.exports)) {
      if (exps.length > 0) {
        lines.push(`  ${file}: ${exps.join(', ')}`);
      }
    }
    lines.push('');
  }

  // 模块依赖图 (紧凑格式)
  if (map.imports && Object.keys(map.imports).length > 0) {
    lines.push('## 模块依赖 (核心)');
    // 只展示有多个依赖或被多个文件依赖的模块
    const significant = Object.entries(map.imports)
      .filter(([, deps]) => deps.length >= 2)
      .slice(0, 30);
    for (const [file, deps] of significant) {
      lines.push(`  ${file} ← ${deps.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ═══ Internal: Directory Walker ═══

function walkDir(
  root: string, dir: string, depth: number, maxDepth: number,
  includeContents: boolean, maxFileChars: number,
): DirNode {
  const name = path.basename(dir);
  const stat = fs.statSync(dir);

  if (stat.isFile()) {
    let size = stat.size;
    let contentSample = '';
    // 文本文件读取样本
    if (includeContents && isTextFile(name) && size < 50_000) {
      try {
        contentSample = fs.readFileSync(dir, 'utf-8').slice(0, maxFileChars);
      } catch { /* binary or unreadable */ }
    }
    return { name, type: 'file', size, ...(contentSample ? { content: contentSample } : {}) };
  }

  if (!stat.isDirectory()) return { name, type: 'dir' };
  if (depth >= maxDepth) return { name, type: 'dir' };
  if (SKIP_DIRS.has(name)) return { name, type: 'dir' };

  const children: DirNode[] = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      // 跳过隐藏文件(含.env等敏感文件)和锁文件
      if (entry.startsWith('.') && entry !== '.gitignore' && entry !== '.editorconfig') continue;
      if (SKIP_FILES.has(entry)) continue;
      if (entry.endsWith('.lock') || entry.endsWith('.log')) continue;

      const child = walkDir(root, path.join(dir, entry), depth + 1, maxDepth, includeContents, maxFileChars);
      if (child) children.push(child);
    }
  } catch { /* permission error */ }

  return { name, type: 'dir', children: children.length > 0 ? children : undefined };
}

function isTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || name === 'Dockerfile' || name === 'Makefile';
}

// ═══ Internal: Import Graph ═══

function buildImportGraph(root: string, tree: DirNode): { imports: Record<string, string[]>; exports: Record<string, string[]> } {
  const imports: Record<string, string[]> = {};
  const exports: Record<string, string[]> = {};

  walkForImports(root, tree, root, imports, exports);
  return { imports, exports };
}

function walkForImports(
  root: string, node: DirNode, currentPath: string,
  imports: Record<string, string[]>, exports: Record<string, string[]>,
): void {
  if (node.type === 'file') {
    const ext = path.extname(node.name);
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      const filePath = path.relative(root, currentPath).replace(/\\/g, '/');
      try {
        const content = fs.readFileSync(currentPath, 'utf-8');
        // 解析 import/export
        const importLines = content.match(/^import\s+.*$/gm) || [];
        const exportLines = content.match(/^export\s+(const|function|class|interface|type|async|default)\s+(\w+)/gm) || [];

        const deps: string[] = [];
        for (const line of importLines) {
          const match = line.match(/from\s+['"](.+?)['"]/);
          if (match) {
            const dep = match[1];
            // 只记录项目内相对路径
            if (dep.startsWith('.')) deps.push(dep);
          }
        }
        if (deps.length > 0) imports[filePath] = deps;

        const exps: string[] = [];
        for (const line of exportLines) {
          const match = line.match(/export\s+(?:const|function|class|interface|type|async|default)\s+(\w+)/);
          if (match) exps.push(match[1]);
        }
        if (exps.length > 0) exports[filePath] = exps;

      } catch { /* read error */ }
    }
  }

  if (node.children) {
    for (const child of node.children) {
      walkForImports(root, child, path.join(currentPath, child.name), imports, exports);
    }
  }
}

function collectExports(node: DirNode, result: Record<string, string[]>, currentPath: string): void {
  if (node.type === 'file' && node.exports) {
    result[currentPath] = node.exports;
  }
  if (node.children) {
    for (const child of node.children) {
      collectExports(child, result, path.join(currentPath, child.name));
    }
  }
}

// ═══ Internal: Formatting ═══

function formatTree(node: DirNode, indent: string, isRoot: boolean): string {
  if (node.type === 'file') {
    const sizeStr = node.size ? ` (${formatSize(node.size)})` : '';
    const exportStr = node.exports?.length ? ` [exports: ${node.exports.slice(0, 5).join(', ')}]` : '';
    return `${indent}📄 ${node.name}${sizeStr}${exportStr}`;
  }

  const children = node.children || [];
  if (children.length === 0 && !isRoot) {
    return `${indent}📁 ${node.name}/ (空)`;
  }

  const lines: string[] = [];
  if (!isRoot) {
    lines.push(`${indent}📁 ${node.name}/`);
  }
  const childIndent = isRoot ? '' : indent + '  ';
  const sorted = [...children].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of sorted) {
    lines.push(formatTree(child, childIndent, false));
  }
  return lines.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ═══ Internal: Stats ═══

function countStats(node: DirNode, onFile: (node: DirNode) => void): void {
  if (node.type === 'file') onFile(node);
  if (node.children) {
    for (const child of node.children) countStats(child, onFile);
  }
}

function collectFileContents(node: DirNode, result: Record<string, string>, fullPath: string, root: string): void {
  if (node.type === 'file' && node.content) {
    const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
    result[relPath || node.name] = node.content;
  }
  if (node.children) {
    for (const child of node.children) {
      collectFileContents(child, result, path.join(fullPath, child.name), root);
    }
  }
}

function buildFingerprint(workingDir: string): string {
  try {
    const { execSync } = require('node:child_process');
    return execSync('git rev-parse HEAD', { cwd: workingDir, timeout: 5000 }).toString().trim().slice(0, 12);
  } catch {
    try {
      const keyFiles = ['package.json', 'tsconfig.json', 'AGENTS.md'];
      return keyFiles.map(f => {
        try { const s = fs.statSync(path.join(workingDir, f)); return `${f}:${s.mtimeMs}`; } catch { return `${f}:missing`; }
      }).join('|');
    } catch { return Date.now().toString(36); }
  }
}

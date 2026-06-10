// ============================================================
// Context Engine — 项目扫描器
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';
import type { RepoInfo, TechStack, ProjectStructure, ProjectRules, GitInfo } from 'deepseek-code-shared';

export interface ScanOptions {
  workingDir: string;
  /** 扫描深度 */
  maxDepth?: number;
  /** 是否读取规则文件全文 */
  readRulesFull?: boolean;
}

/**
 * 扫描项目，生成 RepoInfo（优先用缓存）
 */
export async function scanRepo(options: ScanOptions): Promise<RepoInfo> {
  const { workingDir, readRulesFull = false } = options;
  const name = path.basename(workingDir);

  // 检查缓存：key 文件未变则复用
  const cacheDir = path.join(workingDir, '.deepseek-code', 'cache');
  const cacheFile = path.join(cacheDir, 'repo-info.json');
  const keyFiles = ['package.json', 'tsconfig.json', 'AGENTS.md', 'README.md', 'pyproject.toml'];

  const currentFingerprint = keyFiles
    .map((f) => {
      const fp = path.join(workingDir, f);
      try { const s = fs.statSync(fp); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return `${f}:missing`; }
    })
    .join('|');

  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (cached._version === 2 && cached._fingerprint === currentFingerprint) {
        console.log(`💾 缓存命中 → ${cached.techStack?.language ?? 'Unknown'}`);
        return cached as RepoInfo;
      }
    } catch { /* cache corrupt, re-scan */ }
  }

  const [techStack, structure, rules, git] = await Promise.all([
    detectTechStack(workingDir),
    scanStructure(workingDir),
    loadRules(workingDir, readRulesFull),
    detectGitInfo(workingDir),
  ]);

  const result: RepoInfo = {
    name,
    rootDir: workingDir,
    techStack,
    structure,
    rules,
    git: git ?? undefined,
  };

  // 写缓存（含版本号，scanner 逻辑变化时自动失效）
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ ...result, _fingerprint: currentFingerprint, _version: 2 }, null, 2), 'utf-8');
  } catch { /* ignore write errors */ }

  return result;
}

/**
 * 生成给模型看的项目摘要
 */
export function buildRepoSummary(repo: RepoInfo): string {
  const lines: string[] = [
    `# 项目: ${repo.name}`,
    `路径: ${repo.rootDir}`,
    '',
    '## 技术栈',
    `- 语言: ${repo.techStack.language}`,
    `- 框架: ${repo.techStack.framework ?? '无'}`,
    `- 构建工具: ${repo.techStack.buildTool}`,
    `- 包管理: ${repo.techStack.packageManager}`,
    `- 运行时: ${repo.techStack.runtime}`,
    repo.techStack.uiLibrary ? `- UI 库: ${repo.techStack.uiLibrary}` : null,
    repo.techStack.orm ? `- ORM: ${repo.techStack.orm}` : null,
    repo.techStack.testFramework ? `- 测试框架: ${repo.techStack.testFramework}` : null,
    '',
    '## 项目结构',
    `- 入口文件: ${repo.structure.entryFiles.join(', ') || '未识别'}`,
    `- 路由文件: ${repo.structure.routeFiles.join(', ') || '未识别'}`,
    `- 配置文件: ${repo.structure.configFiles.join(', ') || '未识别'}`,
    `- 关键目录: ${repo.structure.keyDirectories.join(', ') || '未识别'}`,
    '',
  ].filter(Boolean) as string[];

  if (repo.git) {
    lines.push('## Git 状态', `- 分支: ${repo.git.branch}`, `- 有未提交改动: ${repo.git.hasUncommittedChanges ? '是' : '否'}`);
    if (repo.git.status) lines.push(`- 状态:\n${repo.git.status}`);
    lines.push('');
  }

  if (repo.rules.agentsMd || repo.rules.readme) {
    lines.push('## 项目规则');
    if (repo.rules.agentsMd) lines.push(`- AGENTS.md 已加载 (${repo.rules.agentsMd.length} 字符)`);
    if (repo.rules.readme) lines.push(`- README 已加载 (${repo.rules.readme.length} 字符)`);
  }

  return lines.join('\n');
}

// ============================================================
// 内部实现
// ============================================================

async function detectTechStack(dir: string): Promise<TechStack> {
  const hasFile = (name: string) => fs.existsSync(path.join(dir, name));

  // package.json (Node.js 项目)
  let pkg: Record<string, unknown> | null = null;
  if (hasFile('package.json')) {
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    } catch { /* ignore */ }
  }

  // pyproject.toml (Python 项目)
  let pyproject: Record<string, unknown> | null = null;
  if (hasFile('pyproject.toml')) {
    try {
      // 简单 TOML 解析：提取依赖段
      const raw = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf-8');
      pyproject = parseSimpleToml(raw);
    } catch { /* ignore */ }
  }

  const allDeps = { ...(pkg?.dependencies as Record<string, string> ?? {}), ...(pkg?.devDependencies as Record<string, string> ?? {}) };
  const depNames = Object.keys(allDeps);
  const pyDeps = (pyproject?.dependencies as string[]) ?? [];

  // 确定性语言检测：tsconfig.json → TypeScript，.ts 文件占比高 → TypeScript
  const hasTsConfig = hasFile('tsconfig.json') || hasFile('tsconfig.base.json');
  const isPython = hasFile('pyproject.toml') || hasFile('requirements.txt') || hasFile('setup.py');

  // 快速统计 .ts vs .js 文件
  let tsFiles = 0, jsFiles = 0;
  try {
    const walk = (d: string, depth: number) => {
      if (depth > 3 || tsFiles + jsFiles > 100) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) tsFiles++;
        else if (e.name.endsWith('.tsx')) tsFiles++;
        else if (e.name.endsWith('.js') || e.name.endsWith('.jsx')) jsFiles++;
      }
    };
    walk(dir, 0);
  } catch { /* ignore */ }

  const hasPackageJson = hasFile('package.json');
  const isTypeScript = hasTsConfig || (tsFiles > jsFiles && tsFiles > 3);

  let language: string;
  if (hasPackageJson && isPython) {
    language = isTypeScript ? 'TypeScript + Python' : 'JavaScript + Python';
  } else if (hasPackageJson) {
    language = isTypeScript ? 'TypeScript' : 'JavaScript';
  } else if (isPython) {
    language = 'Python';
  } else {
    language = 'Unknown';
  }

  // Python 框架检测
  const pythonFramework: string | null = pyDeps.some((d: string) => d.includes('fastapi')) ? 'FastAPI'
    : pyDeps.some((d: string) => d.includes('django')) ? 'Django'
    : pyDeps.some((d: string) => d.includes('flask')) ? 'Flask'
    : null;

  return {
    language,
    framework: pythonFramework
      ?? (depNames.includes('next') ? 'Next.js'
      : depNames.includes('react') || depNames.includes('react-dom') ? 'React'
      : depNames.includes('vue') ? 'Vue'
      : depNames.includes('@angular/core') ? 'Angular'
      : depNames.includes('express') ? 'Express'
      : depNames.includes('fastify') ? 'Fastify'
      : depNames.includes('nestjs') ? 'NestJS'
      : null),
    buildTool: pyDeps.some((d: string) => d.includes('uvicorn')) ? 'uvicorn'
      : depNames.includes('vite') ? 'Vite'
      : depNames.includes('webpack') ? 'Webpack'
      : depNames.includes('esbuild') ? 'esbuild'
      : depNames.includes('tsup') ? 'tsup'
      : hasFile('Makefile') ? 'Make'
      : isPython ? 'pip/poetry'
      : 'npm scripts',
    packageManager: hasFile('pnpm-lock.yaml') ? 'pnpm'
      : hasFile('yarn.lock') ? 'yarn'
      : hasFile('package-lock.json') ? 'npm'
      : hasFile('bun.lockb') ? 'bun'
      : hasFile('poetry.lock') ? 'poetry'
      : hasFile('Pipfile.lock') ? 'pipenv'
      : 'unknown',
    runtime: isPython && !hasPackageJson ? 'Python' : 'Node.js',
    uiLibrary: depNames.includes('@mui/material') ? 'Material UI'
      : depNames.includes('antd') ? 'Ant Design'
      : depNames.includes('@shadcn/ui') || depNames.includes('tailwindcss') ? 'shadcn/ui + Tailwind'
      : depNames.includes('element-plus') ? 'Element Plus'
      : depNames.includes('@chakra-ui/react') ? 'Chakra UI'
      : depNames.includes('tailwindcss') ? 'Tailwind CSS'
      : null,
    orm: depNames.includes('prisma') ? 'Prisma'
      : depNames.includes('drizzle-orm') ? 'Drizzle'
      : depNames.includes('typeorm') ? 'TypeORM'
      : depNames.includes('sequelize') ? 'Sequelize'
      : depNames.includes('mongoose') ? 'Mongoose'
      : null,
    testFramework: depNames.includes('vitest') ? 'Vitest'
      : depNames.includes('jest') ? 'Jest'
      : depNames.includes('mocha') ? 'Mocha'
      : depNames.includes('playwright') ? 'Playwright'
      : null,
  };
}

async function scanStructure(dir: string): Promise<ProjectStructure> {
  const hasSrcDir = fs.existsSync(path.join(dir, 'src'));
  const base = hasSrcDir ? path.join(dir, 'src') : dir;

  const entryFiles = findFiles(dir, [
    'index.ts', 'index.tsx', 'index.js', 'main.ts', 'main.tsx', 'app.ts', 'app.tsx',
    'server.ts', 'server.js',
  ], 1);

  const routeFiles = findFiles(base, [
    '**/routes/**', '**/router/**', '**/pages/**', '**/app/**/page.tsx',
    '**/app/**/layout.tsx', '**/route.ts', '**/route.tsx',
  ], 3).slice(0, 10);

  const configFiles = findFiles(dir, [
    'tsconfig.json', 'vite.config.*', 'next.config.*', 'webpack.config.*',
    '.eslintrc*', '.prettierrc*', 'tailwind.config.*', 'postcss.config.*',
    'docker-compose.yml', 'Dockerfile', '.env.example',
  ], 1);

  const keyDirectories = listTopDirs(dir);

  return { hasSrcDir, entryFiles, routeFiles, configFiles, keyDirectories };
}

async function loadRules(dir: string, readFull: boolean): Promise<ProjectRules> {
  const agentsMd = readFileIfExists(path.join(dir, 'AGENTS.md'), readFull ? 10000 : 3000);
  const readme = readFileIfExists(path.join(dir, 'README.md'), readFull ? 20000 : 3000);

  let packageJson: Record<string, unknown> | null = null;
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try { packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch { /* ignore */ }
  }

  let eslintConfig: Record<string, unknown> | null = null;
  for (const name of ['.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', 'eslint.config.js']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      eslintConfig = { file: name, exists: true };
      break;
    }
  }

  let tsconfig: Record<string, unknown> | null = null;
  const tsPath = path.join(dir, 'tsconfig.json');
  if (fs.existsSync(tsPath)) {
    try { tsconfig = JSON.parse(fs.readFileSync(tsPath, 'utf-8')); } catch { /* ignore */ }
  }

  return { agentsMd, readme, packageJson, eslintConfig, tsconfig };
}

async function detectGitInfo(dir: string): Promise<GitInfo | null> {
  try {
    const branch = await execa('git', ['branch', '--show-current'], { cwd: dir, timeout: 5000, reject: false });
    const status = await execa('git', ['status', '--short'], { cwd: dir, timeout: 5000, reject: false });
    const lastCommit = await execa('git', ['log', '-1', '--format=%s'], { cwd: dir, timeout: 5000, reject: false });

    return {
      branch: branch.stdout.trim(),
      status: status.stdout || '',
      hasUncommittedChanges: status.stdout.trim().length > 0,
      lastCommit: lastCommit.stdout.trim() || undefined,
    };
  } catch {
    return null;
  }
}

// ---- 辅助函数 ----

/** 简易 TOML 解析器 —— 支持 [tool.poetry.dependencies] 和 PEP 621 [project] dependencies */
function parseSimpleToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = { dependencies: [] as string[] };
  const deps: string[] = [];
  let inPoetryDeps = false;
  let inPoetryDevDeps = false;
  let inProject = false;
  let inProjectDeps = false;
  let inProjectOptDeps = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // [tool.poetry.dependencies]
    if (trimmed === '[tool.poetry.dependencies]') {
      inPoetryDeps = true; inPoetryDevDeps = false;
      inProject = false; inProjectDeps = false; inProjectOptDeps = false;
      continue;
    }
    // [tool.poetry.dev-dependencies]
    if (trimmed === '[tool.poetry.dev-dependencies]') {
      inPoetryDevDeps = true; inPoetryDeps = false;
      inProject = false; inProjectDeps = false; inProjectOptDeps = false;
      continue;
    }
    // [project] (PEP 621)
    if (trimmed === '[project]') {
      inProject = true; inProjectDeps = false; inProjectOptDeps = false;
      inPoetryDeps = false; inPoetryDevDeps = false;
      continue;
    }
    // dependencies = [...] under [project]
    if (inProject && /^dependencies\s*=\s*\[/.test(trimmed)) {
      inProjectDeps = true;
      const arrMatch = trimmed.match(/^dependencies\s*=\s*\[(.*)\]$/);
      if (arrMatch) {
        // 单行数组: ['pkg1', 'pkg2']
        const inner = arrMatch[1];
        const pkgRegex = /['"]([^'"]+)['"]/g;
        let m;
        while ((m = pkgRegex.exec(inner)) !== null) {
          deps.push(m[1]);
        }
        inProjectDeps = false;
      }
      continue;
    }
    // optional-dependencies under [project]
    if (inProject && trimmed.startsWith('[') && trimmed.includes('optional-dependencies')) {
      inProjectOptDeps = true; inProjectDeps = false;
      continue;
    }

    // 遇到下一个 section 退出当前段
    if (trimmed.startsWith('[') &&
        trimmed !== '[tool.poetry.dependencies]' &&
        trimmed !== '[tool.poetry.dev-dependencies]' &&
        trimmed !== '[project]') {
      inPoetryDeps = false; inPoetryDevDeps = false;
      inProject = false; inProjectDeps = false; inProjectOptDeps = false;
    }

    // 提取依赖名
    if (inPoetryDeps || inPoetryDevDeps) {
      const key = trimmed.split('=')[0]?.trim().replace(/"/g, '');
      if (key && !key.startsWith('#') && !key.startsWith('[')) {
        deps.push(key);
      }
    }
    // PEP 621 续行或多行
    if (inProjectDeps || inProjectOptDeps) {
      const pkgMatch = trimmed.match(/['"]([^'"]+)['"]/);
      if (pkgMatch) deps.push(pkgMatch[1]);
      if (trimmed.endsWith(']')) {
        inProjectDeps = false;
        inProjectOptDeps = false;
      }
    }
  }

  result.dependencies = deps;
  return result;
}

function findFiles(dir: string, patterns: string[], maxDepth: number): string[] {
  const results: string[] = [];
  try {
    walk(dir, 0);
  } catch { /* ignore */ }
  return results;

  function walk(current: string, depth: number) {
    if (depth > maxDepth || results.length >= 20) return;
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(current, e.name);
        const rel = path.relative(dir, full);
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        if (e.isFile() && matchesAny(rel, patterns)) {
          results.push(rel);
        }
        if (e.isDirectory() && depth < maxDepth) {
          walk(full, depth + 1);
        }
      }
    } catch { /* ignore */ }
  }
}

function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    // 简单 glob 匹配
    const regex = new RegExp(
      '^' + p.replace(/\*\*/g, '<<<GLOBSTAR>>>').replace(/\*/g, '[^/]*').replace(/<<<GLOBSTAR>>>/g, '.*') + '$',
    );
    return regex.test(name);
  });
}

function listTopDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function readFileIfExists(filePath: string, maxLength: number): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8').slice(0, maxLength);
  } catch {
    return null;
  }
}

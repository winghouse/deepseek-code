// ============================================================
// AST Symbol Finder — 基于 TypeScript Compiler API 的符号引用查找
// 比纯文本搜索精度更高，能区分注释/字符串/类型引用
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolExecutionResult } from 'deepseek-code-shared';

// TypeScript Compiler API 按需加载（输出 CommonJS 时使用 require）
function getTS(): typeof import('typescript') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('typescript') as typeof import('typescript');
  } catch {
    return null;
  }
}

// ═══ Types ═══

export interface SymbolReference {
  file: string;
  line: number;
  column: number;
  /** 引用所在的上下文（前后各 40 字符） */
  context: string;
  /** 引用类型 */
  kind: 'declaration' | 'reference' | 'import' | 'export' | 'call' | 'type_ref';
}

export interface SymbolFindResult {
  success: boolean;
  symbol: string;
  references: SymbolReference[];
  totalCount: number;
  /** 是否使用了 AST 分析（true=精确，false=文本搜索） */
  astBased: boolean;
  error?: string;
}

// ═══ TypeScript Compiler API 实现 ═══

/**
 * 使用 TypeScript Compiler API 查找符号引用
 * 如果 tsconfig 可用则创建 Program，否则对单个文件做 AST 遍历
 */
export function findSymbolReferencesAST(
  symbolName: string,
  workingDir: string,
): SymbolFindResult {
  // 非 TS 标识符（含特殊字符如 . / -）直接降级文本搜索
  // 合法 TS 标识符: [a-zA-Z_$][a-zA-Z0-9_$]*
  if (!/^[a-zA-Z_$][\w$]*$/.test(symbolName)) {
    return textSearchReferences(symbolName, workingDir);
  }

  const references: SymbolReference[] = [];

  try {
    const ts = getTS();
    if (!ts) return findSymbolFallback(symbolName, workingDir);

    // Step 1: 查找 tsconfig
    const tsconfigPath = findTsconfig(workingDir);
    if (!tsconfigPath) {
      // Fallback: 逐文件 AST 遍历
      return findSymbolFallback(symbolName, workingDir);
    }

    // Step 2: 创建 Program
    const configFile = ts.readConfigFile(tsconfigPath, (f) => fs.readFileSync(f, 'utf-8'));
    if (configFile.error) {
      return findSymbolFallback(symbolName, workingDir);
    }

    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(tsconfigPath),
    );

    // 限制文件范围：只包含项目源文件，排除 node_modules
    const rootFileNames = parsedConfig.fileNames.filter(
      (f) => !f.includes('node_modules') && !f.includes('.deepseek-code'),
    );

    if (rootFileNames.length === 0) {
      return findSymbolFallback(symbolName, workingDir);
    }

    const program = ts.createProgram({
      rootNames: rootFileNames,
      options: {
        ...parsedConfig.options,
        noEmit: true,
        skipLibCheck: true,
      },
    });

    // Step 3: 遍历所有源文件查找符号引用
    for (const sourceFile of program.getSourceFiles()) {
      // 跳过 lib 文件和 node_modules
      if (sourceFile.isDeclarationFile && sourceFile.fileName.includes('node_modules')) continue;
      if (!sourceFile.fileName.startsWith(workingDir)) continue;

      findReferencesInFile(ts, sourceFile, symbolName, program, references);
    }

    if (references.length > 0) {
      return {
        success: true,
        symbol: symbolName,
        references,
        totalCount: references.length,
        astBased: true,
      };
    }

    // AST 未找到，降级为文本搜索
    return findSymbolFallback(symbolName, workingDir);
  } catch (e) {
    // TS API 异常，降级
    return findSymbolFallback(symbolName, workingDir);
  }
}

/**
 * 在单个源文件中遍历 AST 查找符号引用
 */
function findReferencesInFile(
  ts: typeof import('typescript'),
  sourceFile: import('typescript').SourceFile,
  symbolName: string,
  program: import('typescript').Program,
  references: SymbolReference[],
): void {
  const text = sourceFile.getFullText();

  function visit(node: import('typescript').Node) {
    // 检查标识符
    if (ts!.isIdentifier(node) && node.text === symbolName) {
      // 跳过注释和字符串中的文本（TypeScript AST 已自动排除）
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      const start = Math.max(0, node.getStart() - 40);
      const end = Math.min(text.length, node.getEnd() + 40);
      const context = text.slice(start, end).replace(/\n/g, '↵');

      // 判断引用类型
      let kind: SymbolReference['kind'] = 'reference';

      // 检查父节点类型
      const parent = node.parent;
      if (ts!.isVariableDeclaration(parent) && parent.name === node) {
        kind = 'declaration';
      } else if (ts!.isFunctionDeclaration(parent) && parent.name === node) {
        kind = 'declaration';
      } else if (ts!.isClassDeclaration(parent) && parent.name === node) {
        kind = 'declaration';
      } else if (ts!.isInterfaceDeclaration(parent) && parent.name === node) {
        kind = 'declaration';
      } else if (ts!.isTypeAliasDeclaration(parent) && parent.name === node) {
        kind = 'declaration';
      } else if (ts!.isEnumDeclaration(parent) && parent.name === node) {
        kind = 'declaration';
      } else if (ts!.isImportSpecifier(parent) && parent.name === node) {
        kind = 'import';
      } else if (ts!.isExportSpecifier(parent) && parent.name === node) {
        kind = 'export';
      } else if (ts!.isCallExpression(parent) && parent.expression === node) {
        kind = 'call';
      } else if (ts!.isTypeReferenceNode(parent) && parent.typeName === node) {
        kind = 'type_ref';
      }

      references.push({
        file: path.relative(program.getCurrentDirectory(), sourceFile.fileName),
        line: line + 1,
        column: character + 1,
        context,
        kind,
      });
    }

    ts!.forEachChild(node, visit);
  }

  visit(sourceFile);
}

/**
 * Fallback: 逐文件 AST 遍历（无 tsconfig 时）
 */
function findSymbolFallback(
  symbolName: string,
  workingDir: string,
): SymbolFindResult {
  try {
    const ts = getTS();
    if (ts) {
      const references: SymbolReference[] = [];

      const ext = ['.ts', '.tsx'];
      walkSourceFiles(workingDir, (filePath) => {
        try {
          const sourceText = fs.readFileSync(filePath, 'utf-8');
          const sourceFile = ts!.createSourceFile(
            filePath,
            sourceText,
            ts!.ScriptTarget.Latest,
            true,
          );

          function visit(node: import('typescript').Node) {
            if (ts!.isIdentifier(node) && node.text === symbolName) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              const start = Math.max(0, node.getStart() - 40);
              const end = Math.min(sourceText.length, node.getEnd() + 40);
              const context = sourceText.slice(start, end).replace(/\n/g, '↵');

              let kind: SymbolReference['kind'] = 'reference';
              const parent = node.parent;
              if (ts!.isVariableDeclaration(parent) || ts!.isFunctionDeclaration(parent) ||
                  ts!.isClassDeclaration(parent) || ts!.isInterfaceDeclaration(parent) ||
                  ts!.isTypeAliasDeclaration(parent) || ts!.isEnumDeclaration(parent)) {
                if ('name' in parent && parent.name === node) kind = 'declaration';
              } else if (ts!.isImportSpecifier(parent)) {
                kind = 'import';
              } else if (ts!.isExportSpecifier(parent)) {
                kind = 'export';
              } else if (ts!.isCallExpression(parent) && parent.expression === node) {
                kind = 'call';
              } else if (ts!.isTypeReferenceNode(parent) && parent.typeName === node) {
                kind = 'type_ref';
              }

              references.push({
                file: path.relative(workingDir, filePath),
                line: line + 1,
                column: character + 1,
                context,
                kind,
              });
            }
            ts!.forEachChild(node, visit);
          }
          visit(sourceFile);
        } catch { /* skip parse errors */ }
      });

      if (references.length > 0) {
        return {
          success: true,
          symbol: symbolName,
          references,
          totalCount: references.length,
          astBased: true,
        };
      }
    }
  } catch {
    // TypeScript 不可用时继续降级
  }

  // 最终降级：纯文本搜索
  return textSearchReferences(symbolName, workingDir);
}

/**
 * 最终降级：纯文本搜索
 */
function textSearchReferences(
  symbolName: string,
  workingDir: string,
): SymbolFindResult {
  const references: SymbolReference[] = [];
  const ext = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md'];

  walkFiles(workingDir, (filePath) => {
    if (!ext.some((e) => filePath.endsWith(e))) return;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        let col = -1;
        while ((col = lines[i].indexOf(symbolName, col + 1)) !== -1) {
          const context = lines[i].slice(Math.max(0, col - 40), col + symbolName.length + 40);
          references.push({
            file: path.relative(workingDir, filePath),
            line: i + 1,
            column: col + 1,
            context,
            kind: 'reference',
          });
        }
      }
    } catch { /* skip */ }
  });

  return {
    success: true,
    symbol: symbolName,
    references,
    totalCount: references.length,
    astBased: false,
  };
}

// ═══ ToolExecutionResult 适配器 ═══

/**
 * 将 SymbolFindResult 转换为 ToolExecutionResult（兼容现有 audit 接口）
 */
export function toToolResult(result: SymbolFindResult): ToolExecutionResult {
  const { symbol, references, totalCount, astBased } = result;
  const exists = totalCount > 0;

  const content = exists
    ? references
        .map((r) => {
          const kindLabel = r.kind === 'declaration' ? '[声明]' :
            r.kind === 'import' ? '[导入]' :
            r.kind === 'export' ? '[导出]' :
            r.kind === 'call' ? '[调用]' :
            r.kind === 'type_ref' ? '[类型]' : '';
          return `${kindLabel} ${r.file}:${r.line}:${r.column}`;
        })
        .join('\n')
    : `未找到 "${symbol}" 的引用`;

  return {
    success: true,
    content,
    metadata: {
      symbol,
      referenceCount: totalCount,
      exists,
      astBased,
      // 前 10 条引用的详细信息
      references: references.slice(0, 10).map((r) => ({
        file: r.file,
        line: r.line,
        column: r.column,
        context: r.context.slice(0, 80),
        kind: r.kind,
      })),
    },
  };
}

// ═══ Helpers ═══

function findTsconfig(dir: string): string | null {
  const candidates = ['tsconfig.json', 'tsconfig.base.json'];
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function walkSourceFiles(dir: string, cb: (filePath: string) => void) {
  walkDir(dir, cb, ['.ts', '.tsx']);
}

function walkFiles(dir: string, cb: (filePath: string) => void) {
  walkDir(dir, cb, ['.ts', '.tsx', '.js', '.jsx', '.json', '.md']);
}

function walkDir(dir: string, cb: (filePath: string) => void, allowedExt: string[]) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.deepseek-code' || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && allowedExt.some((e) => full.endsWith(e))) {
        cb(full);
      } else if (entry.isDirectory()) {
        walkDir(full, cb, allowedExt);
      }
    }
  } catch { /* skip permission errors */ }
}

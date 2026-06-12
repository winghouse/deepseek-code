// ============================================================
// Tool Layer — 工具定义（JSON Schema）
// ============================================================

import type { ToolDefinition } from 'deepseek-code-shared';

/**
 * V1 只读工具集 —— 安全的分析工具
 */
export const READ_ONLY_TOOLS: ToolDefinition[] = [
  {
    name: 'glob',
    description: 'list_files 的别名，列出目录和文件结构。',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: '目录路径' },
        depth: { type: 'number', description: '递归深度，默认 2' },
      },
      required: [],
    },
  },
  {
    name: 'list_files',
    description:
      '列出当前仓库的目录和文件结构。可以指定目录路径，如果不指定则列出根目录。返回文件名、类型、大小等基本信息。',
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: '要列出的目录路径（相对于项目根目录），不指定则列出根目录',
        },
        depth: {
          type: 'number',
          description: '递归深度，默认 2',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_file_range',
    description:
      '【推荐】按行范围读取文件。startLine 和 endLine 必须指定。用于读取大型文件的指定片段。优先使用此工具而非 read_file，尤其是文件较大时。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径（相对项目根目录）' },
        startLine: { type: 'number', description: '起始行号（从 1 开始）' },
        endLine: { type: 'number', description: '结束行号（包含）' },
      },
      required: ['filePath', 'startLine', 'endLine'],
    },
  },
  {
    name: 'read_file',
    description:
      '读取指定文件内容。文件超过 500 行时会提示使用 read_file_range 分段读取。支持可选的 startLine/endLine。不会读取 .env 等敏感文件。',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '要读取的文件路径（相对于项目根目录）',
        },
        startLine: {
          type: 'number',
          description: '起始行号（从 1 开始），不指定则从第 1 行开始',
        },
        endLine: {
          type: 'number',
          description: '结束行号（包含），不指定则读到文件末尾',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'read_file_batch',
    description:
      '批量读取多个文件，支持 DeepSeek V4 1M 上下文。一次性加载多个相关文件的完整内容，用于跨文件分析和全项目审查。每个文件返回前 200 行。最多 20 个文件。',
    parameters: {
      type: 'object',
      properties: {
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: '要读取的文件路径列表',
        },
        maxLinesPerFile: {
          type: 'number',
          description: '每个文件最多读取行数，默认 200',
        },
      },
      required: ['filePaths'],
    },
  },
  {
    name: 'search_code',
    description:
      '使用 ripgrep 在项目中搜索代码。支持正则表达式，可以指定文件类型过滤。返回匹配的文件路径和行内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '搜索模式（正则表达式）',
        },
        fileTypes: {
          type: 'string',
          description: '文件类型过滤，如 ".ts,.tsx,.js"',
        },
        directory: {
          type: 'string',
          description: '搜索目录（相对于项目根目录），不指定则搜索整个项目',
        },
        caseSensitive: {
          type: 'boolean',
          description: '是否区分大小写，默认 false',
        },
        maxResults: {
          type: 'number',
          description: '最大结果数，默认 20',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'web_fetch',
    description:
      '获取网页全文。自动检测分页并遍历（如 API 文档的多页结构）。用于阅读文档、API 参考、技术文章。支持 maxPages 参数控制遍历页数，设为 0 表示不限制（最多 20 页）。返回清理后的文本，每页有明确分隔符。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要获取的网页起始 URL',
        },
        maxChars: {
          type: 'number',
          description: '每页最大返回字符数，默认 5000',
        },
        maxPages: {
          type: 'number',
          description: '最大遍历页数: 1=只取当前页(默认), 3=最多3页, 0=不限制(最多20)。自动通过 rel=next 或"下一页"链接发现下一页。',
        },
        format: {
          type: 'string',
          enum: ['text', 'markdown'],
          description: '返回格式: text=纯文本(默认), markdown=保留结构',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    description:
      '联网搜索，获取最新信息。用于查询文档、API 参考、最新技术方案、新闻等需要实时信息的问题。支持 site: 语法限定搜索某个网站。返回标题、URL 和内容摘要。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词或问题',
        },
        site: {
          type: 'string',
          description: '限定搜索域名，如 "github.com" 或 "developer.mozilla.org"。只返回该域名下的结果。',
        },
        contextSize: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: '结果详细程度: low=仅标题, medium=标题+摘要(默认), high=含全文',
        },
        maxResults: {
          type: 'number',
          description: '最大结果数，默认 10',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'git_status',
    description: '获取当前 git 仓库的状态，包括当前分支、已修改文件、未跟踪文件等信息。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'git_diff',
    description: '获取当前 git 工作区的差异（diff）。可以查看未暂存的改动、已暂存的改动或与某个分支的差异。',
    parameters: {
      type: 'object',
      properties: {
        staged: {
          type: 'boolean',
          description: '是否只查看已暂存的改动，默认 false（查看未暂存的改动）',
        },
        file: {
          type: 'string',
          description: '只查看指定文件的差异',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_log',
    description: '查看 git 提交历史。返回最近 N 条提交的 hash 和消息。',
    parameters: {
      type: 'object',
      properties: { maxCount: { type: 'number', description: '返回的提交数量，默认 10' } },
      required: [],
    },
  },
  {
    name: 'git_show',
    description: '查看某次提交的详细内容（diff）。可用于确认某次提交是否修复了某个问题。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '提交 hash 或引用，默认 HEAD' },
        stat: { type: 'boolean', description: '是否只显示文件变更统计' },
      },
      required: [],
    },
  },
  {
    name: 'read_package_json',
    description: '读取并解析项目的 package.json，返回项目名称、脚本命令、依赖列表等关键信息。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'read_project_rules',
    description:
      '读取项目的规则文件（AGENTS.md、CLAUDE.md、.cursorrules 等），了解项目的编码规范和约束。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

/**
 * V1.5 写工具 —— 需要安全确认
 */
export const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'apply_patch',
    description:
      '应用 unified diff patch 修改文件。使用 git apply 或手动解析 diff 格式。修改前会展示文件列表并要求用户确认。',
    parameters: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description: 'Unified diff 格式的补丁内容',
        },
        filesAffected: {
          type: 'array',
          items: { type: 'string' },
          description: '受影响的文件路径列表',
        },
      },
      required: ['patch', 'filesAffected'],
    },
  },
  {
    name: 'run_cmd',
    description:
      '执行命令。executable 只能是: pnpm/npm/node/git/tsc/vitest。args 是参数数组。cwd 是相对工作区路径。不要用 cd 或 &&。',
    parameters: {
      type: 'object',
      properties: {
        executable: { type: 'string', description: 'pnpm / npm / node / git / tsc / vitest' },
        args: { type: 'array', items: { type: 'string' }, description: '参数数组' },
        cwd: { type: 'string', description: '相对路径，默认 "."' },
        reason: { type: 'string', description: '为什么要执行这个命令' },
      },
      required: ['executable', 'args'],
    },
  },
  {
    name: 'write_file',
    description:
      '直接写入文件内容。会自动备份原文件到 .deepseek-code/backups/。禁止修改 .env 等敏感文件。',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '要写入的文件路径（相对于项目根目录）',
        },
        content: {
          type: 'string',
          description: '文件完整内容',
        },
      },
      required: ['filePath', 'content'],
    },
  },
];

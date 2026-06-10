# AGENTS.md — DeepSeek Code 自举规范

> 本项目是 DeepSeek Code CLI，它的 Agent 代码本身就是用 AI Agent 辅助开发的。

## 项目概述

DeepSeek Code：面向中文开发者的低成本、长上下文、本地可控 AI 编程 Agent CLI。

## 技术栈

- TypeScript + Node.js
- pnpm monorepo
- commander（CLI 框架）
- execa（命令执行）
- ripgrep（代码搜索）
- simple-git（Git 操作，计划中）
- DeepSeek API（OpenAI 兼容格式）

## 项目结构

```
deepseek-code/
├─ packages/
│  ├─ shared/     # 共享类型、工具函数
│  ├─ core/       # Agent Runtime 核心
│  │  ├─ model/   # DeepSeek API 适配器 + 路由
│  │  ├─ tools/   # 工具定义 + 执行器
│  │  ├─ context/ # 项目扫描 + 会话存储
│  │  ├─ agent/   # Agent 主循环 + Planner
│  │  └─ safety/  # 权限 + 密钥过滤
│  └─ cli/        # CLI 入口
├─ AGENTS.md      # 本文件
└─ package.json
```

## 编码规范

- 严格 TypeScript，不使用 any（除非有明确注释说明）
- 每个模块有清晰的 index.ts 导出
- 函数使用 async/await，错误通过 try/catch 处理
- 注释使用简体中文
- 文件名使用 kebab-case
- 类型定义集中在 shared 包

## 命令

```bash
# 安装依赖
pnpm install

# 构建所有包
pnpm build

# 类型检查
pnpm typecheck

# 启动 CLI
pnpm cli
```

## 重要约定

### Agent 开发原则

1. **先读后改** — Agent 必须先充分理解项目再修改
2. **最小改动** — 只改必要的代码，不大范围重构
3. **安全第一** — 命令和写操作必须经过权限检查
4. **记录可追溯** — 所有操作保存到 session

### 架构约束

1. core 包不依赖 cli 包
2. shared 包不依赖任何其他包
3. 模型适配器接口统一，方便以后换模型
4. 工具定义和工具执行分离

### V1 不做

- 不做桌面版 / VS Code 插件
- 不做 TUI（终端 UI 框架）
- 不做 MCP Server 实现（只预留接口）
- 不做实时流式输出

### V1.5 计划

- 流式输出 chatStream
- apply_patch 工具
- run_command 工具（带权限）
- 模型自动升级（任务失败后从 Flash 升 Pro）
- AGENTS.md 中文模板库

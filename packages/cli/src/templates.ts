// ============================================================
// DeepSeek Code CLI — AGENTS.md 模板
// ============================================================

export function getTemplates(): Record<string, string> {
  return {
  'nextjs': `# AGENTS.md — Next.js 项目

## 技术栈
- Next.js + TypeScript
- React 组件（函数组件 + Hooks）
- Tailwind CSS / CSS Modules 样式
- pnpm 包管理

## 项目结构
- \`src/app/\` — App Router 页面和布局
- \`src/components/\` — 可复用组件
- \`src/lib/\` — 工具函数和 API 封装
- \`src/types/\` — TypeScript 类型定义

## 编码规范
- 优先 Server Components，需要交互时用 "use client"
- 组件名 PascalCase，文件名 kebab-case
- 使用 \`next/link\` 做页面跳转，不用 \`<a>\`
- API 路由放 \`src/app/api/\`

## 命令
\`\`\`bash
pnpm dev      # 开发服务器
pnpm build    # 生产构建
pnpm lint     # ESLint 检查
pnpm typecheck # TypeScript 类型检查
\`\`\`
`,

  'vue3': `# AGENTS.md — Vue 3 项目

## 技术栈
- Vue 3 + TypeScript (Composition API)
- Vite 构建
- pnpm 包管理

## 项目结构
- \`src/views/\` — 页面组件
- \`src/components/\` — 公共组件
- \`src/stores/\` — Pinia 状态管理
- \`src/router/\` — Vue Router 配置
- \`src/api/\` — API 请求封装

## 编码规范
- 使用 \`<script setup lang="ts">\` 语法
- 组件名 PascalCase，文件名 kebab-case
- 响应式数据用 ref/reactive
- 路由跳转用 useRouter

## 命令
\`\`\`bash
pnpm dev      # 开发服务器
pnpm build    # 生产构建
pnpm lint     # ESLint
\`\`\`
`,

  'react': `# AGENTS.md — React 项目

## 技术栈
- React 18+ + TypeScript
- Vite 构建
- pnpm 包管理

## 项目结构
- \`src/pages/\` — 页面组件
- \`src/components/\` — 公共组件
- \`src/hooks/\` — 自定义 Hooks
- \`src/services/\` — API 服务
- \`src/types/\` — 类型定义

## 编码规范
- 函数组件 + Hooks
- Props 类型必须显式定义
- useEffect 依赖数组必须完整
- 组件文件名与组件名一致 (PascalCase)

## 命令
\`\`\`bash
pnpm dev      # 开发服务器
pnpm build    # 生产构建
pnpm lint     # ESLint
\`\`\`
`,

  'wechat-miniapp': `# AGENTS.md — 微信小程序

## 技术栈
- 微信小程序原生 / Taro / uni-app
- TypeScript
- 微信开发者工具

## 项目结构
- \`pages/\` — 页面目录
- \`components/\` — 组件目录
- \`utils/\` — 工具函数
- \`app.js/app.ts\` — 入口文件

## 编码规范
- 页面放 pages/ 下，每个页面一个文件夹
- 组件放 components/ 下
- 使用 wx.xxx API，注意兼容性
- setData 只传变更字段
- 避免在 data 中放大量数据

## 注意事项
- 包体积限制 2MB（分包可扩展）
- 域名需要在小程序后台配置白名单
- 审核注意：不得有诱导分享、虚拟支付等违规内容
`,

  'express': `# AGENTS.md — Express 后端项目

## 技术栈
- Node.js + Express + TypeScript
- pnpm 包管理

## 项目结构
- \`src/routes/\` — 路由
- \`src/middleware/\` — 中间件
- \`src/services/\` — 业务逻辑
- \`src/models/\` — 数据模型
- \`src/types/\` — 类型定义

## 编码规范
- RESTful API 设计
- 错误统一用 error middleware 处理
- 请求参数用 express-validator 校验
- 敏感信息用环境变量

## 命令
\`\`\`bash
pnpm dev      # 开发服务器
pnpm build    # 编译 TypeScript
pnpm start    # 生产启动
\`\`\`
`,

  'python-fastapi': `# AGENTS.md — FastAPI 项目

## 技术栈
- Python 3.10+ + FastAPI
- Pydantic 数据校验
- Poetry / pip 包管理

## 项目结构
- \`api/\` — 路由和端点
- \`models/\` — Pydantic 模型
- \`services/\` — 业务逻辑层
- \`core/\` — 配置和依赖注入
- \`tests/\` — 测试

## 编码规范
- 使用 Pydantic v2 语法
- 类型注解必须完整
- 路由用 APIRouter 模块化
- 数据库操作放 services 层

## 命令
\`\`\`bash
poetry install    # 安装依赖
uvicorn main:app --reload  # 开发
pytest            # 测试
\`\`\`
`,
  };
}

export function generateAgentsMdTemplate(): string {
  return `# AGENTS.md

> 本文件为 AI Coding Agent（如 DeepSeek Code、Claude Code、Cursor Agent）提供项目指引。

## 项目概述

<!-- 简要描述项目是什么，解决什么问题 -->

## 技术栈

<!-- 列出的主要技术栈 -->

## 项目结构

<!-- 关键目录和文件说明 -->

## 编码规范

<!-- 代码风格、命名约定、文件组织规范 -->

## 测试

\`\`\`bash
# 运行测试
npm test

# 运行 lint
npm run lint

# 构建
npm run build
\`\`\`

## 重要约定

<!-- Agent 必须遵守的约束 -->
`;
}

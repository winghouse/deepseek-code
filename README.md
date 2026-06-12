# DeepSeek Code

> 🤖 面向中文开发者的 DeepSeek V4 原生 AI 编程 Agent CLI
>
> 🏗️ **本项目 100% 由 DeepSeek V4 构建**——从架构设计到代码实现，全部由 AI 完成

[![CI](https://github.com/deepseek-code/deepseek-code/actions/workflows/ci.yml/badge.svg)](https://github.com/deepseek-code/deepseek-code/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-330%20passed-green)
![Eval](https://img.shields.io/badge/eval-26%2F26%20passed-green)

## 定位

**终端里的 AI 编程 Agent**。不是 IDE 插件，不是聊天机器人。它能读项目、规划步骤、搜索代码、读取文件、执行命令、修复错误、审查代码、抓取网页、生成测试。

**核心差异化**：
- 🔬 **确定性审查** — 能用程序判断的绝不用模型（跨平台检测、文件存在、JSON 解析），零幻觉
- 🎯 **Target-first 路由** — 先识别目标对象（workspace/url/file/chat_history），再判断意图
- 🧠 **LLM 主分类器** — 替代手写正则，DeepSeek V4-Flash 做意图识别，98% 准确率
- 🔒 **5 层安全防线** — Route Guard → Executor Guard → Path Guard → Env Guard → Failure Budget
- 📊 **KV Cache 优化** — 5 层稳定前缀，缓存命中率实时监控

## 快速开始

### 安装

```bash
# npm 全局安装（推荐）
npm i -g deepseek-codecli

# Docker
docker run -e DEEPSEEK_API_KEY=sk-xxxx winghouse/deepseek-code "解释项目"

# 从源码安装
git clone https://github.com/winghouse/deepseek-code.git
cd deepseek-code
pnpm install
pnpm build
```

### 配置

```bash
# 环境变量
export DEEPSEEK_API_KEY=sk-xxxx

# 可选: Google 质量搜索
export SERPER_API_KEY=xxxx

# 或使用配置文件
~/.deepseek-code/config.json
```

### 初始化

```bash
# 一键初始化（自动检测技术栈生成配置）
dscode init
```

### 使用

```bash
# 分析项目
dscode "解释当前项目结构"

# 审查代码
dscode "审查当前项目代码有哪些优化"

# 查看 Git diff
dscode diff

# 读取网页
dscode "看下 https://api-docs.deepseek.com 的文档内容"

# 修复错误
dscode "修复 packages/core/src/agent/router.ts 的类型错误"

# 交互模式
dscode chat

# 完整命令列表
dscode help
```

## 架构

```
CLI Layer         ← commander + readline + 交互模式
  ↓
Router            ← Target Resolver → LLM(主) → Heuristic(降级) → Permission Guard
  ↓
Agent Runtime     ← Planner(JSON mode) → Loop(流式 + 并行工具) → State Machine
  ↓
Pipeline Layer    ← audit / repair / review-diff / url-fetch
  ↓
Tool Layer        ← 12 工具 (10读 + 3写 + 6审查) + 4 搜索引擎
  ↓
Context Engine    ← Scanner(指纹缓存) + PromptBuilder(5层前缀) + Memory(持久化)
  ↓
Model Adapter     ← DeepSeek V4-Pro(reasoning_effort) + V4-Flash(JSON mode) + Retry
  ↓
Safety Layer      ← Route → Executor → Path → Env → Budget (5 layers)
```

详见 [ARCHITECTURE.md](ARCHITECTURE.md)

## 评测体系

```bash
pnpm test              # 单元测试 (330)
pnpm test:eval         # Eval Task (26 mock)
pnpm test:all          # 全部 (330 + 26)
```

| 套件 | 用例 | 通过 |
|------|------|------|
| 单元测试 | 238 | 100% |
| 路由评测 (离线) | 101 | 100% |
| 真实任务 | 20 | 100% |
| 复合任务 | 10 | 100% |
| Agent E2E | 5 | 100% |
| Router --live | 45 | 98% (P0=0) |

## 技术栈

TypeScript · Node.js 20+ · pnpm monorepo · commander · execa · ripgrep · DeepSeek V4 API

## 开发

```bash
pnpm install
pnpm dev          # 开发模式
pnpm typecheck    # 类型检查
pnpm test         # 运行测试
pnpm build        # 构建
pnpm cli          # 启动 CLI
```

## 许可证

MIT

---

> 🏗️ 本项目 100% 由 **DeepSeek V4** 构建。从架构设计、类型系统、路由引擎到评测体系，全部代码由 AI 生成，人工仅做需求引导和质量验证。

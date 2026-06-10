# DeepSeek Code — 下阶段规划

> 基准: v0.3.0 | 278 测试 | 40 评测 | P0=0 | 2026-06-10

---

## 当前状态评估

### 已稳定，不再大改
- ✅ Target-first 路由架构 (LLM 主分类器 + heuristic 降级)
- ✅ 8 层 Agent Runtime (Router → Agent → Pipeline → Tool → Context → Model → Safety)
- ✅ 4 条 Pipeline (audit/repair/review-diff/url-fetch)
- ✅ 5 层安全防线
- ✅ 5 层 KV Cache 优化
- ✅ 3 层评测体系 (单元/路由 E2E/Live E2E)

### 待偿还技术债
- P1: loop.ts 670行 / executor.ts 980行 单体未拆分
- P1: 50+ 处 `catch {}` 静默异常
- P1: TOML 解析器零测试
- P2: CLI `index.ts` 1281行 (config + templates 已抽出)
- P2: 模型名 30+ 处硬编码
- P2: CLI 包零测试覆盖

### DeepSeek V4 已利用
- ✅ `response_format: json_object` (Planner)
- ✅ `reasoning_effort: high` (审查任务)
- ✅ 流式输出 (逐字显示)
- ✅ 并行工具调用
- ✅ KV Cache 命中率监控
- ✅ 5s 超时路由 (Flash)
- ✅ 退避重试 (DeepSeekClient)

### DeepSeek V4 未利用
- ⬜ 1M 上下文 — 当前最多读 50K，未充分利用长上下文做跨文件分析
- ⬜ Function Calling strict mode — 当前 `tool_choice: auto`，未用 strict 模式强制工具调用

---

## 下阶段方向

### 方向 A: 发布就绪 (Distribution Ready)
**目标**: 让外部用户能安装使用

```
npm publish → 用户 `npm i -g deepseek-code` → `dscode`
```

| 任务 | 工作量 | 价值 |
|------|--------|------|
| package.json 发布字段 (bin/files/repository) | 小 | 高 |
| npm publish 配置 (.npmignore) | 小 | 高 |
| Docker 镜像 (`docker run dscode`) | 中 | 中 |
| 错误提示中文化 (API Key 缺失等) | 小 | 高 |
| CHANGELOG 发布流程 | 小 | 中 |

### 方向 B: 质量加固 (Quality Hardening)
**目标**: 偿还 P1 技术债，提升代码可维护性

| 任务 | 工作量 | 价值 |
|------|--------|------|
| executor.ts 拆分 (980行 → 4文件) | 大 | 高 |
| loop.ts 拆分 (670行 → 3文件) | 中 | 高 |
| CLI 零测试覆盖 → 补 10 条 | 中 | 高 |
| `catch {}` 静默异常 → 加 debug 日志 | 中 | 中 |
| 模型名常量提取 (30+处硬编码) | 小 | 中 |

### 方向 C: 能力扩展 (Capability Expansion)
**目标**: 利用 DeepSeek V4 1M 上下文做更深层分析

| 任务 | 工作量 | 价值 |
|------|--------|------|
| 全项目跨文件分析 (利用 1M 上下文) | 大 | 高 |
| 依赖图分析 (import graph) | 中 | 高 |
| 测试覆盖率报告 | 中 | 中 |
| MCP 客户端接入 (工具扩展) | 大 | 中 |

### 方向 D: 体验优化 (UX Polish)
**目标**: 提升日常使用体验

| 任务 | 工作量 | 价值 |
|------|--------|------|
| 交互模式历史搜索 (Ctrl+R) | 小 | 中 |
| 会话管理优化 (搜索/删除/导出) | 小 | 中 |
| 彩色输出 (diff/错误/警告) | 小 | 中 |
| `dscode init` 一键项目配置 | 小 | 高 |

---

## 推荐路线: A → B → D → C

### 第一阶段: 发布就绪 (A) — 1-2 天

```
目标: 用户能 `npm i -g deepseek-code` 直接用

1. 完善 package.json (bin / files / repository / keywords)
2. 创建 .npmignore
3. 首次发布流程文档
4. 中文错误提示优化
```

**为什么先做 A**: 当前所有功能都在本地跑，没有外部用户验证。发布后能得到真实反馈。

### 第二阶段: 质量加固 (B) — 2-3 天

```
目标: 偿还最影响开发效率的技术债

1. executor.ts 拆分 (优先，每次改工具都在这 980 行文件里找)
2. 模型名常量提取 (30+ 处硬编码，每次模型升级都要批量替换)
3. CLI 补测试 (config.ts / templates.ts 已有独立模块，补测试不复杂)
```

**为什么 B 在这个位置**: 发布前做质量加固→发布后维护成本低。但如果先发布收集反馈再修，也能并行。

### 第三阶段: 体验优化 (D) — 1 天

```
目标: 日常使用更顺手

1. dscode init (自动检测技术栈生成 AGENTS.md)
2. 彩色 diff 输出
3. 会话搜索/删除
```

### 第四阶段: 能力扩展 (C) — 按需

```
目标: 利用 1M 上下文做深水区功能

1. 全项目跨文件分析 (适合大型项目审查)
2. MCP 接入 (扩展第三方工具)
```

**为什么 C 最后**: 需要更多真实用户反馈来验证方向。1M 上下文和 MCP 都是"有了更好"的功能，不是当前瓶颈。

---

## 不建议做的事

- ❌ 桌面版 (Tauri/Electron) — CLI 还没站稳
- ❌ 多 Agent 并行 — 单 Agent 稳定性优先
- ❌ VS Code 插件 — 先让 CLI 体验完整
- ❌ 支持其他模型 (Claude/GPT) — 先吃透 DeepSeek V4

---

## 里程碑

```
v0.3.0 ✅  已完成   架构稳定 + 评测体系 + 路由优化

v0.4.0 🎯  发布版   npm publish + Docker + 中文错误提示
v0.5.0 🎯  加固版   executor/loop 拆分 + CLI 测试 + 模型名常量
v0.6.0 🎯  体验版   dscode init + 彩色输出 + 会话管理
v1.0.0 🎯  正式版   1M 上下文 + 用户文档站 + 示例项目
```

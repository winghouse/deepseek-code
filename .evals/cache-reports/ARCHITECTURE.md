# DeepSeek V4 KV Cache 适配架构

## 目标

最大化利用 DeepSeek V4 自动 Context Caching：提高缓存命中率、降低首轮后续请求成本、减少无效大上下文注入，同时不牺牲审查/修复质量。

## 核心设计

### 1. Prompt 五层前缀结构

```
[Global Prefix]      — 身份/规则/工具协议（所有请求一致）
[Runtime Prefix]     — OS/Shell/工作区（同机器稳定）
[Project Prefix]     — 技术栈/目录结构/项目规则（同仓库稳定，不含 git 状态）
[Session Prefix]     — 任务描述/计划/模式（同 session 稳定，不含 phase）
[Dynamic Tail]       — 当前输入/工具结果/git 状态/phase/knownFiles
```

- Git 状态（branch/dirty）在 Dynamic Tail，不破坏 Project Prefix
- Phase 在 Dynamic Tail，不破坏 Session Prefix
- knownFiles 在 Dynamic Tail

### 2. contextPolicy — 上下文注入策略

| contextPolicy | 项目扫描 | 上下文注入 | 典型路由 |
|---|---|---|---|
| `none` | 跳过 | 无 | 寒暄、确认词 |
| `session_state` | 跳过 | session 状态 | 继续任务、对话回顾、短承接词 |
| `project_summary` | repoSummary | 轻量 index | 默认路由 |
| `full_agent` | repoSummary + seed context | 轻量 index + 审计提示 | 代码审查、架构分析 |

### 3. RepoMap 策略

- **默认不注入完整 RepoMap**，只注入 `repoSummary + 目录 index`
- full_agent + audit_task 时注入确定性 seed context：
  ```
  1. package.json / tsconfig
  2. 入口文件
  3. 安全/权限/认证模块
  4. 数据流/路由层
  ```
- 只有模型通过工具明确需要时才读取 RepoMap slice

### 4. Phase2 输入缩减

Phase2（详细报告）不再接收完整工具调用历史。只接收：
- System message（稳定前缀）
- Phase1 摘要
- structured findings + knownFiles
- validator reason（仅重试时）

收益：Phase2 prompt 从 ~20K 降至 ~6K（-70%）。

### 5. Per-Call 指标采集

每次模型调用记录 `ModelCallStats`：
```
model | route | contextPolicy | prefixHashes
promptTokens | cacheHitTokens | cacheMissTokens
latencyMs | costUsd
```

数据流：DeepSeek API → parseUsage → continueLoop → SessionStats.modelCalls → CLI context stats

### 6. 质量门禁

`pnpm eval:cache` 每次输出两维数据：

**性能维度：**
- cold/warm/recall prompt tokens, hit rate, cost, latency per-call

**质量维度：**
- findingsCount, fakePathCount, retryCount, degradedReport
- missingLocations, unmatchedFindings

门禁标准：
- warm same task hit rate ≥ 70%
- recall vs audit prompt ≤ 20%
- fake paths = 0
- degraded report = 0
- finding recall 不低於优化前 90%

### 7. 可观测性命令

```bash
dscode context stats        # 聚合视图：按 contextPolicy 分层展示
dscode context show <id>    # 单会话：prefixHashes + 模型调用列表
dscode context explain <id> # 诊断：跨会话 hash 对比 + miss 归因
pnpm eval:cache             # 真实 API 基准
pnpm cache:quality          # 发版前门禁检查
```

## 优化效果

| 指标 | 优化前 | 优化后 | 目标 |
|------|--------|--------|------|
| warm audit hit rate | 43% | 78% | ≥70% |
| recall vs audit prompt | 16% | 13% | ≤20% |
| warm audit cost | $0.0132 | $0.0049 | -63% |
| fake paths | — | 0 | 0 |
| degraded report | — | false | false |
| Phase2 prompt | ~20K | ~6K | -70% |

## 不做事项

- 不引入手动缓存服务（DeepSeek 自动缓存）
- 不默认预热所有项目
- 不为缓存牺牲报告质量
- 不切换模型供应商

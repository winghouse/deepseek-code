# DeepSeek V4 优势利用分析

> 基准: 278 测试 | 8000 行代码 | 2026-06-10

---

## DeepSeek V4 可用但未使用的功能

| V4 功能 | 当前使用 | 可优化方向 |
|----------|---------|-----------|
| `reasoning_effort` | 0 处 | Pro 推理深度控制，审查任务提升质量 |
| `response_format` (JSON mode) | 0 处 | Planner/Router/Audit 消除 JSON 解析错误 |
| 1M context + KV Cache | 部分 (5层前缀) | 未充分利用长上下文做跨文件分析 |
| Pro/Flash 路由 | 简单复杂度判断 | 可用 Flash 预估 + Pro 深度分析混合模式 |
| 并行工具调用 | 1 处 | Loop 支持 parallel tool calls |
| 流式输出 | 仅 llm_direct | Agent 计划和回复缺流式 |
| `max_tokens` 动态调整 | 固定值 | 根据任务类型动态分配 |

---

## 优先级排序 (基于证据)

### P0: 高价值 + 低风险 + 证据明确

#### 1. `response_format` JSON 模式 — 消除 Planner 解析失败

**证据**: `planner.ts:108-184` 有 ~76 行 JSON 解析容错代码 (`extractStepsArray`, `findObjArrays`, 递归探测)。每次 Agent 启动约有 10-20% 概率 JSON 解析失败需要降级。

**V4 能力**: `response_format: { type: "json_object" }` 确保模型 100% 输出合法 JSON。

**实现**: `deepseek.ts:chat()` 添加 `response_format` 参数。

**风险**: 低。仅影响非流式 API 调用，流式模式不受影响。

#### 2. Agent 流式回复

**证据**: `loop.ts:327` 每轮打印 token 用量但无流式输出。`handleLlmDirect` (cli/index.ts:1192) 已实现 SSE 流式，但 Agent 主循环未使用。用户需要等 30-90s 才能看到结果。

**V4 能力**: `stream: true` + SSE 解析，与 llm_direct 相同模式。

**实现**: `deepseek.ts:chatStream()` 已有流式方法，Agent Loop 接入即可。

**风险**: 中。需要处理流式输出中的 tool_calls 和最终回答的分离。

### P1: 中价值 + 中风险

#### 3. `reasoning_effort` — 审查任务提升深度

**证据**: `loop.ts:282` 调用 Pro 模型时未设置 `reasoning_effort`。审计/审查任务从用户反馈来看，偶尔会产生幻觉（如误报 scripts 是数组）。V4-Pro 的 `reasoning_effort: "high"` 可减少幻觉。

**V4 能力**: `reasoning_effort: "minimal" | "low" | "medium" | "high"`。high 模式会进行更深度的 CoT 推理。

**实现**: audit_task 路由到 Agent 时，传递 `reasoning_effort: "high"`。

**风险**: 低。会增加 ~20% token 消耗和 1.5x 延迟，但审查质量提升明显。

#### 4. 并行工具调用

**证据**: `loop.ts:304` 发送工具列表给模型，`loop.ts:350-420` 串行执行每个工具调用。DeepSeek V4 支持 parallel tool calls，模型可同时请求多个独立工具。

**V4 能力**: 并行 function calling，模型返回多个 tool_calls，执行器并行调用。

**实现**: 当多个 tool_call 互不依赖时（如同时读多个不相关文件），并行执行。

**风险**: 中。需要工具依赖分析，但读文件类工具天然可并行。

### P2: 低风险 + 长尾收益

#### 5. Pro/Flash 动态路由优化

**证据**: `model/router.ts:58` 基于 `estimateTaskComplexity` 做简单关键词匹配。可用 Flash 快速评估 Pro 是否必要。

**实现**: 先用 Flash 返回 `{"needsPro": true/false}`，50 token 解决问题。

#### 6. `max_tokens` 动态调整

**证据**: `deepseek.ts:28` 固定 `max_tokens: undefined`（不限制）。部分简单任务浪费 token。

**实现**: 简单任务设上限（Flash 512，Pro 2048），复杂任务不设限。

#### 7. KV Cache 命中率监控

**证据**: `prompt-builder.ts` 5 层前缀设计精良，但无命中率统计。

**实现**: 在 `loop.ts` token 统计中加入 cache_hit_tokens 展示。

---

## 推荐开发路线

```
当前基线: 278 测试全过，P0=0

第一步 (本次推荐):
  P0: JSON mode → 消除 Planner 解析容错代码
  P0: Agent 流式 → 用户体验质变

第二步 (下个迭代):
  P1: reasoning_effort → 审查质量提升
  P1: 并行工具 → 减少 Agent 轮次

第三步 (长尾):
  P2: 动态路由 / max_tokens / Cache 监控
```

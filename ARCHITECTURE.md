# DeepSeek Code CLI — 架构全景图

> 生成日期: 2026-06-10 | 238 测试 | 42 源文件 | ~8000 行 TypeScript

---

## 一、项目分层

```
┌─────────────────────────────────────────────┐
│ CLI Layer         │ 1281行  │ 命令行入口     │
│ packages/cli/src/ │ index.ts │ 交互模式       │
│                   │ config   │ 配置管理       │
│                   │ templates│ 模板系统       │
├─────────────────────────────────────────────┤
│ Agent Layer       │ 1500行  │ 路由+规划+循环 │
│ packages/core/src │ router   │ 意图分类       │
│ /agent/           │ planner  │ 计划生成       │
│                   │ loop     │ 主执行循环     │
├─────────────────────────────────────────────┤
│ Pipeline Layer    │ 1600行  │ 专用管线       │
│ packages/core/src │ audit    │ 确定性审查     │
│ /tools/           │ repair   │ 错误修复       │
│                   │ review   │ Diff审查       │
│                   │ url-fetch│ 网页抓取       │
├─────────────────────────────────────────────┤
│ Tool Layer        │ 2000行  │ 工具定义+执行  │
│ packages/core/src │ executors│ 执行器         │
│ /tools/           │ definit  │ 12工具定义     │
│                   │ web-srch │ 网络搜索       │
├─────────────────────────────────────────────┤
│ Context Engine    │ 900行   │ 项目理解       │
│ packages/core/src │ scanner  │ 项目扫描       │
│ /context/         │ prompt   │ 前缀构建       │
│                   │ memory   │ 会话记忆       │
├─────────────────────────────────────────────┤
│ Model Adapter     │ 300行   │ API调用        │
│ packages/core/src │ deepseek │ DeepSeek适配   │
│ /model/           │ router   │ 模型路由       │
├─────────────────────────────────────────────┤
│ Safety Layer      │ 230行   │ 安全防护       │
│ packages/core/src │ permiss  │ 权限管理       │
│ /safety/          │ secret   │ 密钥过滤       │
├─────────────────────────────────────────────┤
│ Shared Types      │ 630行   │ 跨层类型       │
│ packages/shared/  │ types.ts │ 类型定义       │
│                   │ utils.ts │ 工具函数       │
└─────────────────────────────────────────────┘
```

---

## 二、请求生命周期

```
用户输入 "审查当前项目代码"
    │
    ▼
┌── CLI Layer ──────────────────────────────┐
│ dscode "审查当前项目..."                    │
│   → routeInput(task, ctx, llmClient)       │
│                                             │
│   路由链 (router.ts):                        │
│   1. Command Router → no match              │
│   2. LLM Router    → intent=audit_task     │
│      ├─ resolveTarget() → workspace        │
│      ├─ LLM slot-filling (Flash)           │
│      └─ applyTargetGuard()                 │
│   3. Permission Guard → agent_readonly     │
│                                             │
│   调度: audit_task → Agent Loop            │
└─────────────────────────────────────────────┘
    │
    ▼
┌── Agent Layer ─────────────────────────────┐
│ runAgentLoop(task, config)                  │
│                                             │
│   1. scanRepo() → 项目指纹                  │
│   2. buildPrompt() → 5层前缀               │
│   3. generatePlan(Flash) → JSON步骤         │
│   4. continueLoop()                         │
│      ├─ 模型调用 (Pro/Flash)                │
│      ├─ 工具调用 → executeTool()            │
│      ├─ 结果处理                             │
│      ├─ no-progress 检测 (3轮无新文件→停止) │
│      └─ 循环直到完成/失败/超步数             │
│   5. 保存 session → .deepseek-code/         │
└─────────────────────────────────────────────┘
```

---

## 三、路由系统

```
routeInput(input, ctx, llmClient)
│
├─ Command Router (确定性命中)
│   help/exit/clear/status/sessions/model/diff
│   → local_action
│
├─ LLM Router (主分类器, 有API Key时)
│   │
│   ├─ resolveTarget()
│   │   url → URL检测 + lastExternalResource继承
│   │   workspace → 默认
│   │   chat_history → 回顾关键词
│   │
│   ├─ LLM slot-filling (Flash, 1024 tokens)
│   │   schema: 24 intents × 7 executions
│   │
│   ├─ applyTargetGuard()
│   │   URL → 禁止 scanProject/explain_project
│   │
│   └─ normalizeRouteDecision()
│       readonly → 过滤写工具 + 降级execution
│       url_fetch_pipeline → web_fetch + web_search
│
├─ Heuristic Router (regex 降级, 无API Key时)
│   30+ 正则规则覆盖: 寒暄/能力/URL/debug/code/
│   test/audit/explain/会话回顾/短追问
│
└─ Fallback → unknown + llm_direct + needsClarification
```

### 24 个 Intent

| 类别 | Intent | 说明 |
|------|--------|------|
| 命令 | command_help/exit/clear/status/model/sessions/resume | 系统命令 |
| 对话 | small_talk, capability_question, conversation_summary, continue_previous_task | 闲聊 |
| 项目 | explain_project, debug_task, code_task, test_task, config_task | 开发任务 |
| 审查 | audit_task, webpage_summary, webpage_content_question, external_doc_question, url_safety_check | 分析任务 |
| 兜底 | unknown, previous_result_question | 降级 |

### 7 个 Execution Mode

| Mode | 扫项目 | 调模型 | 调工具 | 用途 |
|------|--------|--------|--------|------|
| local_action | ❌ | ❌ | ❌ | 系统命令 |
| llm_direct | ❌ | ✅ Flash | ❌ | 闲聊/问答 |
| llm_direct_limited | ❌ | ✅ | ❌ | 能力受限问答 |
| url_fetch_pipeline | ❌ | ❌ | ✅ | 网页抓取 |
| agent_readonly | ✅ | ✅ Pro | ✅只读 | 分析任务 |
| agent_plan | ✅ | ✅ | 需确认 | 计划执行 |
| agent_execute | ✅ | ✅ | 可写 | 自动执行 |

---

## 四、工具矩阵 (12 个)

### 只读工具 (10个)

| 工具 | 实现 | 用途 |
|------|------|------|
| read_file | executors.ts | 读取文件内容 (50K 截断) |
| read_file_range | executors.ts | 按行范围读取 |
| search_code | executors.ts | ripgrep 代码搜索 (5s超时) |
| list_files | executors.ts | 列出目录结构 |
| glob | executors.ts | list_files 别名 |
| web_search | web-search.ts | 网络搜索 (Serper→搜狗→百度→Bing) |
| web_fetch | web-search.ts | 获取网页全文 + 分页遍历 |
| git_status | executors.ts | Git 状态 |
| git_diff | executors.ts | Git 差异 |
| read_package_json | executors.ts | 读取 package.json |
| read_project_rules | executors.ts | 读取 AGENTS.md |

### 写工具 (3个)

| 工具 | 安全机制 |
|------|---------|
| run_cmd | executable白名单(pnpm/npm/git/tsc/vitest/yarn), shell:false, safeEnv |
| apply_patch | 统一diff解析, 失败自动回滚 |
| write_file | resolveSafe路径穿越防护 |

### 审查工具 (6个)

| 工具 | 用途 |
|------|------|
| read_json_path | JSON路径解析 |
| list_scripts | 列出所有scripts |
| detect_cross_platform | 跨平台命令检测 |
| file_exists | 文件存在检查 |
| find_references | AST符号引用查找 |
| verifyFinding | 发现验证 |

---

## 五、Pipeline 管线 (4个)

| Pipeline | 入口 | 模型调用 | 说明 |
|----------|------|---------|------|
| audit_pipeline | `dscode audit` 命令 | 0-1次Flash | 确定性检查 + Flash候选 |
| repair_pipeline | debug_task输入 | 0-1次Pro | 错误解析 + 根因分析 |
| review_diff_pipeline | git diff输入 | 0次 | 变更审查 (安全/API/测试) |
| url_fetch_pipeline | URL输入 | 0-1次Flash | URL验证 + 抓取 + 搜索降级 |

---

## 六、上下文工程 (5层前缀)

```
buildPrompt(repoInfo, session)
│
├─ Global Prefix    (所有请求一致)
│   角色定义 + 工具协议 + 安全规则
│   → KV Cache 100% 命中
│
├─ Runtime Prefix   (同机器稳定)
│   OS/Shell/Workspace/Node版本
│   → KV Cache 高命中
│
├─ Project Prefix   (同项目稳定)
│   技术栈 + 目录结构 + AGENTS.md + Git状态
│   → scanner 指纹缓存
│
├─ Session Prefix   (同会话稳定)
│   任务描述 + 已知文件 + 计划 + 缓存hits
│   → resume时复用
│
└─ Dynamic Tail     (每轮变化)
│   用户输入 + 工具结果 + 错误信息
│   → 0%缓存命中
```

---

## 七、安全架构 (5层防线)

```
Layer 1: Route Guard
  normalizeRouteDecision() → readonly清空写工具

Layer 2: Executor Guard
  READONLY_TOOL_BLOCKED / COMMAND_OUTSIDE_WORKSPACE

Layer 3: Path Guard
  resolveSafe() → 拒绝workspace外路径

Layer 4: Env Guard
  safeEnv() → 仅传11个白名单环境变量

Layer 5: Failure Budget
  BLOCKED立即熔断, 普通2次, 总计5次上限
  SOFT_ERRORS (timeout/bad_pattern) 不参与熔断
```

### 安全机制细节

| 机制 | 说明 |
|------|------|
| 密钥过滤 | 8种格式 (API Key/JWT/AWS/私钥) → [FILTERED] |
| 命令白名单 | pnpm/npm/git/tsc/vitest/yarn, shell:false |
| 路径穿越 | resolveSafe拒绝 ../ /home/ /Users/ /etc/ |
| URL安全 | 仅http/https, 禁localhost/内网/metadata/IPv6变体 |
| applyPatch回滚 | 失败自动恢复已写入文件 |
| 并发保护 | FileMemoryStore原子写入 (.tmp→rename) |

---

## 八、搜索引擎架构

```
web_search(query)
│
├─ 1. Serper API (Google质量)
│   SERPER_API_KEY 环境变量或 ~/.deepseek-code/config.json
│
├─ 2. 搜狗 HTML抓取 (AION移植, 境内免费)
│   sogou.com/web → <div class="vrwrap"> 解析
│
├─ 3. 百度 HTML抓取 (境内免费)
│   baidu.com/s → <div class="c-container"> 解析
│
└─ 4. Bing HTML抓取 (国际兜底)
    bing.com/search → <li class="b_algo"> 解析
```

---

## 九、Agent Loop 状态机

```
initializing → scanning → planning
  → awaiting_plan_approval → analyzing
  → awaiting_patch_approval → applying_patch
  → verifying → completed
  → failed (可重入 initializing)
  → repairing (可回到 analyzing)

非法迁移: 记录warning但不阻断 (兼容旧session)
```

### 停止条件

| 条件 | 说明 |
|------|------|
| done | 模型输出最终回答 |
| needs_user_input | 等待用户确认 |
| tool_blocked | 工具被熔断(TOOL_CIRCUIT_BROKEN) |
| too_many_failures | 总失败次数≥5 |
| no_progress | 连续3轮无新文件读取 |
| budget_exceeded | 步数超限 |

---

## 十、交互会话状态持久化

```
InteractiveSessionState → .deepseek-code/sessions/interactive-current.json
│
├─ chatHistory (最近100条)
├─ lastAgentResult (上一轮任务结果)
├─ lastExternalResource (上一轮涉及URL)
├─ recentExternalResources (历史URL)
├─ pendingAction (待处理动作)
└─ conversationFocus (对话焦点: file/symbol)
```

---

## 十一、测试矩阵

| 包 | 测试文件 | 用例数 | 覆盖 |
|----|---------|--------|------|
| shared | utils.test.ts | 12 | 复杂度/模型推荐/ID生成/截断/敏感文件 |
| core | router-eval.test.ts | 98 | 8套件 (explain/debug/code/context/url/...) |
| core | security.test.ts | 19 | readonly拦截/路径/命令白名单/熔断 |
| core | repair.test.ts | 40 | 错误解析/文件提取/根因分析/E2E |
| core | permissions.test.ts | 8 | 风险分级/权限决策/缓存 |
| core | audit.test.ts | 10 | JSON路径/脚本/跨平台/验证/AST |
| core | planner.test.ts | 9 | JSON解析/格式兼容/降级 |
| core | prompt-builder.test.ts | 11 | 前缀一致性/排序/缓存 |
| core | scanner.test.ts | 4 | 项目扫描/包管理器/缓存 |
| core | diff.test.ts | 5 | unified/SEARCH-REPLACE/多hunk |
| core | loop.test.ts | 3 | 工具调用/readonly拦截/no-progress |
| core | secret-filter.test.ts | 8 | API Key/JWT/AWS/私钥过滤 |
| core | memory.test.ts | 8 | 保存/加载/列表/删除 |
| **总计** | **13文件** | **238** | |

---

## 十二、技术债务清单

| 级别 | 数量 | 典型问题 |
|------|------|---------|
| P0 | 0 | 已清零 |
| P1 | 5 | loop拆分、TOML测试、catch静默、executor拆分、内联导入 |
| P2 | 6 | 模型名硬编码、extractStepsArray、fallback常量、CLI零测试、日志、重试装饰器 |

---

## 十三、关键指标

```
源文件:     42 (.ts)
测试文件:   13 (.test.ts)
测试用例:   238
RouterEval: 98条, 8套件
总行数:     ~8000行 (含注释/空行)
工具:       12 (10读+3写+6审查)
Pipeline:   4 (audit/repair/review-diff/url-fetch)
搜索引擎:   4 (Serper/搜狗/百度/Bing)
安全防线:   5层 (Route/Executor/Path/Env/Budget)
模型:       DeepSeek V4 Pro + Flash
```

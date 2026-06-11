# Changelog

## v0.6.2 (2026-06-12)

### 安全修复

- **web_fetch SSRF 收口**: `executeWebFetch` 强制调用 `validateUrl`，重定向后逐跳二次校验
- **run_cmd 纳入只读拦截**: 之前只拦 `run_command`，漏了 `run_cmd`
- **搜索来源标记修正**: sogou 重复调用删除，baidu→sogou→baidu，bing→duckduckgo→bing
- **workflow engine 权限加固**: readonly 模式禁写 + writeTools 白名单统一

### 工程质量

- **response_format/reasoning_effort/disableThinking 解耦**: 从 `tools` 分支移出，Plan 生成时正确生效
- **vitest 收紧**: 55 测试文件→27，排除 pipeline-bench 基准脚本和 workspace 符号链接重复
- **pnpm cli 修复**: 包名错误修正为 `pnpm build && node`
- **evalMode 收口**: 从硬编码+外部覆写改为函数参数
- **autofix 产品描述收缩**: "自动修复" → "审计并生成修复建议"

## v0.6.1 (2026-06-11)

### 修复

- **node/npx 加回 SAFE_EXECUTABLES**: 三模式权限系统已在上层门控
- **修复 security.test.ts** 适配新的白名单

## v0.6.0 (2026-06-11)

### 三模式系统

- **📋 计划模式** (`/plan`): 只读/分析/搜索，写操作弹窗提议切换
- **✏️ 编辑模式** (`/edit`): 默认模式，写操作逐项审批 (y=允许/n=拒绝/a=免审/auto=切自主)
- **🚀 自主模式** (`/auto`): 全自动执行，不弹窗
- **弹窗自动升级**: plan 模式遇到写操作→提议切换 edit；edit 审批支持免审同类/切自主
- **删除关键词写操作检测**: 不再在 Agent 执行前盲问"可能需要写文件"

### LLM Router 重构

- **砍掉 168 行关键词规则**: heuristic router 从 20+ 条规则精简到 4 条安全网
- **LLM Router 主分类**: 所有意图分类交给 DeepSeek Flash，关键词仅做 fallback
- **Fallback 改进**: 无 LLM Client 时默认 `agent_readonly`（有工具总比没工具好）
- **Router JSON fallback**: Flash 非纯 JSON 输出时自动提取 markdown 代码块

### Thinking 优化

- **Plan disableThinking**: Flash thinking 消耗 91% output tokens → 禁用后通过率 5%→99%
- **Phase1/2 disableThinking**: 摘要和详细报告禁用 thinking，避免空白输出
- **Agent reasoningEffort**: high→medium，防止 Pro thinking 吞输出 tokens
- **disableThinking 基础设施**: 新增 `ChatOptions.disableThinking`，chat() 和 chatStream() 均支持

### 权限审批

- **四层分类**: 免审(safe)/需确认(needs_confirm)/高风险(dangerous)/禁止(forbidden)
- **会话内免审**: `a` 键记忆同类工具，本次会话不再询问
- **只读→临时授权**: 权限弹窗通过后自动临时切换，不需要用户手动 `/write`
- **静默拦截修复**: 删除了循环中 `if (isWrite && readOnly)` 的静默移除

### 流程优化

- **两阶段输出**: Phase1 核心摘要(5-7s) + Phase2 详细报告(KV Cache 复用前缀)
- **Router Spinner**: 消除 "分析意图" 阶段的 2-5s 静默等待
- **假流式移除**: 最终响应直接输出，不再逐字慢放
- **Agent 空响应兜底**: Pro 输出为空时追加提示重试
- **Plan 步骤描述**: 秃工具名→操作对象+目标，禁止分析结论
- **审查豁免 no-progress**: 换策略即重置计数，5 轮才截断

### Workflow Runner v0

- **5 种节点**: BEGIN/END/TOOL/PIPELINE/CONDITION
- **安全表达式 DSL**: 递归下降解析器，不用 eval
- **模板变量**: `${input.xxx}` / `${node_id.result.path}`，8000 字符截断
- **3 个内置工作流**: review-diff / repair-typescript / code-review-basic
- **CLI 命令**: `dscode workflow init|validate|run|list|runs|show`

### AutoFix Loop

- **闭环**: audit→repair→apply→verify→retry
- **逐 finding 修复**: 按严重度排序，修复前备份，失败自动回滚
- **CLI 命令**: `dscode autofix --dry-run --write --scope security`

### Eval Task 体系

- **三层模式**: mock(离线/CI) / live-router(真实Flash路由) / live-task(真实LLM+pipeline)
- **26 个 fixture**: 18 旧 + 8 context-aware (conversationFocus/pendingAction/lastExternalResource)
- **报告拆分**: Mock路由准确率 / Live路由准确率 / Task E2E成功率 / 安全不变式
- **pipeline-bench**: 5 节点基准测试，350+ 次真实 LLM 调用

### 安全/质量

- **fileFingerprint ESM 修复**: `require('fs')` → `import { statSync } from 'node:fs'`
- **sessions list 崩溃修复**: 空 id 会话跳过
- **Phase2 prompt 强化**: 禁止工具调用格式文本，强制文件:行号格式
- **runTask/交互模式分发器统一**: 两套代码已同步

## v0.5.3 (2026-06-10)

### Docker

- **Docker Hub 发布**: `winghouse/deepseek-code:latest`
- **多阶段构建**: builder(node:22-alpine) + runtime(node:22-alpine)

## v0.5.2 (2026-06-10)

### npm 发布

- **npm 发布**: `deepseek-codecli@0.5.2`
- **workspace:* 替换**: 发布脚本自动处理

## v0.5.1 (2026-06-10)

### V4 Context Caching + Function Strict

- **KV Cache 前缀稳定性**: Session 前缀移除 knownFiles，移到 Dynamic Tail
- **read_file_batch**: V4 1M 上下文批量读取 20 文件

## v0.5.0 (2026-06-10)

### 质量加固

- **executor.ts 拆分**: 985→833 行，diff 工具提取到 diff-utils.ts
- **模型名常量**: MODEL_PRO/MODEL_FLASH，30+ 处硬编码统一
- **CLI 测试**: config.ts + templates.ts 测试覆盖

## v0.4.0 (2026-06-10)

### npm 发布 + GitHub

- **npm publish**: `deepseek-codecli@0.4.0`
- **GitHub 仓库**: `winghouse/deepseek-code`
- **README 三安装方式**: npm / Docker / 源码

## v0.3.0 (2026-06-09)

### Target Resolver 架构

- **新增 `RouteTarget`**: 路由前先识别目标对象 (workspace/url/chat_history/git_diff/file)，防止 URL 问题误入本地项目分析
- **新增 `TargetResolver`**: 优先级: 显式URL → lastExternalResource 继承 → git_diff → chat_history → workspace
- **新增 `TargetGuard`**: target=url 时禁止 scanRepo / explain_project / agent_execute
- **新增 4 个 Intent**: `webpage_summary`, `webpage_content_question`, `external_doc_question`, `url_safety_check`
- **新增 2 个 ExecutionMode**: `url_fetch_pipeline`, `llm_direct_limited`

### URL Fetch Pipeline

- **url_fetch_pipeline**: 受控网页抓取管线，不进入通用 Agent
- **安全边界**: validateUrl + redirect 每次重校验，禁止 localhost/内网/metadata/IPv6 变体/十进制IP
- **SPA 检测**: 可读文本比 < 15% → fetchQuality=empty，自动触发搜索降级
- **FetchQuality**: complete/partial/empty/blocked/unsupported_content_type
- **ExternalResource 缓存**: 10min TTL，同 URL 复用
- **搜索降级**: 直连失败/质量低 → Serper → 搜狗 → 百度补充信息

### 搜索引擎

- **Serper API**: Google 质量搜索，需 `SERPER_API_KEY` 或 `~/.deepseek-code/config.json` 中 `serperApiKey`
- **搜狗 (Sogou)**: HTML 抓取，免费，境内可用 (移植自 AION)
- **百度 (Baidu)**: HTML 抓取，免费，境内最常用
- **Bing**: HTML 抓取，国际兜底
- **优先级**: Serper → 搜狗 → 百度 → Bing
- **site 参数**: 支持 `site:domain` 限定域名搜索
- **web_fetch**: 直接获取单个 URL 全文，支持 maxPages 自动分页遍历

### 路由增强

- **URL 检测**: 输入含 `https?://` → 自动 `url_fetch_pipeline`
- **URL 追问**: "网页内容是什么" + lastExternalResource → 继承上轮 URL
- **Router Eval**: 91→99 条，新增 external_resource 套件 (4条)
- **LLM Router prompt**: 加入 target 解析规则，先判断 target 再判断 intent

### Agent Loop 状态机

- **新增 `VALID_PHASE_TRANSITIONS`**: 显式 Phase 迁移表，非法迁移记录 warning
- **新增 `setPhase()`**: 安全 Phase 迁移带校验

### 交互体验

- **lastExternalResource 持久化**: 重启 dscode 后仍可追问 "网页内容是什么"
- **interactive session state**: 增强 chatHistory + lastAgentResult + pendingAction 全持久化
- **chatHistory 类型安全**: role 固定为 `'user' | 'assistant' | 'system'`

### 修复

- Router Eval audit-004 (P1): "检查 git diff" 不再误进 llm_direct
- audit-002/003 fixture 同步为 audit_task
- repair_pipeline: 错误解析器支持 TS/ESLint/Build/Test 四种格式
- review_diff_pipeline: 新增 API breaking change / 硬编码密钥 / .only 残留检测
- AST Symbol Finder: TypeScript Compiler API 精确引用查找
- CLI 拆分: config.ts (69行) + templates.ts (213行)

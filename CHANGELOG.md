# Changelog

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

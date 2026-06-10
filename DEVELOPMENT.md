# DeepSeek Code CLI 开发规划

> 最后更新：2026-06-09 20:18

---

## 版本路线

```
V0  验证期    → 借壳验证 + 骨架搭建          → ✅ 完成
V1  基础版    → CLI 内核最小读写闭环           → ✅ 完成
V1.5 稳定版   → 流式 + 重试 + 路由 + 安全       → ✅ 完成
V2  工程版    → 评测体系 + 审计管线 + Dispatcher → ✅ 完成
V2.5 验证版   → Pipeline 增强 + 状态持久化       → 当前阶段
V3  桌面版    → Tauri/Electron 壳               → 规划中
V4  企业版    → 私有化部署                      → 规划中
```

---

## 项目统计

```
7694+ 行 TypeScript  |  40+ 源文件  |  13 测试文件  |  235 测试  |  91 Router Eval cases
```

---

## v2.5 新增功能

### Router Eval 修复与增强
| 变更 | 状态 |
|------|------|
| Router Eval 91/91 100% 通过 | ✅ |
| 新增 git diff 检查启发式规则 | ✅ |
| 短 audit 请求识别 (5-8字) | ✅ |
| audit-002/003 fixture 同步为 audit_task | ✅ |
| 交互模式调度器补全 (repair + diff review) | ✅ |

### Repair Pipeline 增强
| 功能 | 状态 | 说明 |
|------|------|------|
| 结构化错误解析 | ✅ | TS/ESLint/Build/Test 四类格式 |
| 错误码模式匹配 | ✅ | TS2345/TS2339/TS7006 等自动诊断 |
| Pro 模型根因分析 | ✅ | DeepSeek V4 Pro 深度分析 |
| Flash 模型快速分析 | ✅ | Pro 不可用时降级 |
| 文件片段读取 | ✅ | 错误行前后各 15 行上下文 |
| 项目内文件搜索 | ✅ | 找不到文件时递归搜索 |
| Repair 测试覆盖 | ✅ | 40 条测试 (解析/提取/分析/端到端) |

### Review Diff Pipeline 增强
| 功能 | 状态 | 说明 |
|------|------|------|
| git --name-status 解析 | ✅ | M/A/D/R 状态跟踪 |
| API breaking change 检测 | ✅ | 删除 export / 函数签名变更 |
| 测试文件删除告警 | ✅ | 高风险: 删除 .test. 文件 |
| 硬编码密钥检测 | ✅ | API Key / Token / 认证 URL |
| 危险代码模式 | ✅ | eval / innerHTML / shell:true |
| .only() 残留检测 | ✅ | 防止 CI 跳过测试 |
| 分类统计 | ✅ | 按 security/api/test/dependency/config 分类 |

### 交互会话状态持久化
| 功能 | 状态 | 说明 |
|------|------|------|
| InteractiveSessionState | ✅ | 持久化到 .deepseek-code/sessions/ |
| chatHistory 持久化 | ✅ | 重启后恢复对话历史 |
| lastAgentResult 持久化 | ✅ | 恢复任务上下文 |
| pendingAction 持久化 | ✅ | "继续"命令可恢复待处理动作 |
| /new 命令清理 | ✅ | 清除持久化状态 |
| 启动时自动恢复 | ✅ | 显示恢复提示 |

---

## 功能状态

### Agent Runtime
| 功能 | 状态 | 说明 |
|------|------|------|
| 项目扫描 | ✅ | TypeScript/pnpm 确定性识别 + 指纹缓存 + 版本号 |
| 计划生成 | ✅ | Flash 流式步骤 + 防幻觉 + readonly 感知 |
| Agent 主循环 | ✅ | continueLoop + no-progress detector + FailureBudget |
| 会话恢复 | ✅ | 压缩上下文 + 缓存复用 + stale file 检测 |
| 流式输出 | ✅ | 计划步骤逐个出现 + 最终回复逐字 |

### 路由系统
| 功能 | 状态 | 说明 |
|------|------|------|
| Hybrid Router | ✅ | Target Resolver → Heuristic → LLM → Target Guard → PermissionGuard |
| Target Resolver | ✅ | 先判断目标对象 (workspace/url/chat_history/git_diff)，再判断意图 |
| RouteTrace | ✅ | 每层决策可观测 |
| Router Eval | ✅ | 8 套件 95+ 条 + external_resource + `dscode eval router --live` |
| Execution Dispatcher | ✅ | audit_task/repair/review_diff/url_fetch_pipeline → Agent |
| Mode 感知 | ✅ | readonly/ask/auto 三级 |
| URL 目标路由 | ✅ | URL 输入 → url_fetch_pipeline，不扫项目不误进 explain_project |

### 工具层
| 功能 | 状态 | 说明 |
|------|------|------|
| 12 个只读工具 | ✅ | read_file/range, search_code, web_search, web_fetch, list_files, glob, git_*, read_* |
| 4 个写工具 | ✅ | run_cmd (structured), apply_patch (rollback), write_file (backup) |
| 6 个审查工具 | ✅ | read_json_path, list_scripts, detect_cross_platform, file_exists, find_references, verifyFinding |
| AST 符号引用 | ✅ | TypeScript Compiler API 精确查找 (声明/导入/调用/类型引用) |
| 网络搜索 | ✅ | web_search: Serper(付费)→搜狗(免费/境内)→Bing 三层降级 |
| 网页抓取 | ✅ | web_fetch: 直接获取 URL 全文 (text/markdown) + 自动分页遍历 |
| URL 抓取管线 | ✅ | url_fetch_pipeline: SSRF防护 + 摘要 + ExternalResource 记忆 |
| 外部资源记忆 | ✅ | lastExternalResource: URL 上下文跟随追问继承 |
| 路径穿越防护 | ✅ | resolveSafe() 拒绝 workspace 外路径 |
| 环境变量过滤 | ✅ | safeEnv() 仅传白名单变量 |

### 安全架构
| 功能 | 状态 | 说明 |
|------|------|------|
| PermissionGuard | ✅ | 三级模式降级 |
| 执行器拦截 | ✅ | READONLY_TOOL_BLOCKED, COMMAND_OUTSIDE_WORKSPACE |
| FailureBudget | ✅ | BLOCKED 1次熔断, 普通2次, 总计≥5 |
| 路径安全 | ✅ | resolveSafe + run_cmd workspace校验 |
| 环境变量 | ✅ | safeEnv() 11个白名单 |
| applyPatch 回滚 | ✅ | 失败自动恢复已写入文件 |
| 并发保护 | ✅ | FileMemoryStore 原子写入 |

### 上下文工程
| 功能 | 状态 | 说明 |
|------|------|------|
| PromptBuilder 五层 | ✅ | Global→Runtime→Project→Session→Dynamic |
| AGENTS.md 层级 | ✅ | root + packages/* 自动加载 |
| Scanner 缓存 | ✅ | 指纹 + 版本号防过期 |
| max_tokens | ✅ | 不限制，由模型自主控制输出 |

### CLI 命令
| 命令 | 状态 |
|------|------|
| dscode / chat / plan / diff | ✅ |
| rules init / template (7模板) | ✅ |
| sessions / --resume | ✅ |
| --write / --model | ✅ |
| audit (Verified Pipeline) | ✅ |
| init-context | ✅ |
| eval router (--live) | ✅ |

---

## 当前架构

```
CLI Layer (Execution Dispatcher)
  ├─ local_action       → 系统命令
  ├─ llm_direct        → Flash 流式闲聊
  ├─ audit_pipeline    → Verified Audit (确定性+Flash候选)
  ├─ repair_pipeline   → 错误解析+Pro根因分析+补丁生成
  ├─ review_diff_pipeline → git diff 0模型审查
  └─ agent_*           → runAgentLoop

Agent Layer
  ├─ Hybrid Router (Command→Heuristic→LLM→Guard)
  ├─ PromptBuilder (五层前缀)
  └─ Agent Loop (continueLoop + no-progress + failureBudget)

Tool Layer
  ├─ 14 工具 (10R + 4W + 6Audit)
  ├─ resolveSafe + safeEnv
  └─ FailureBudget + rollback

Pipeline Layer
  ├─ repair_pipeline (错误解析→文件定位→Pro分析→补丁)
  ├─ review_diff_pipeline (diff→分类→安全/API/测试检测)
  └─ audit_pipeline (确定性检查→Flash候选→证据验证)

State Layer
  ├─ FileMemoryStore (会话 CRUD)
  ├─ InteractiveSessionState (chatHistory + lastAgent + pendingAction)
  └─ saveInteractiveState / loadInteractiveState (原子写入)

Safety Layer
  ├─ normalizeRouteDecision
  ├─ executeTool guard
  └─ resolveSafe + safeEnv + filterSecrets
```

---

## 安全漏洞修复记录

| # | 漏洞 | 严重度 | 修复 | 状态 |
|---|------|--------|------|------|
| 1 | 路径穿越 | 🔴 P0 | resolveSafe() | ✅ |
| 2 | run_command 可用 | 🔴 P0 | 从 WRITE_TOOLS 移除 | ✅ |
| 3 | process.env 泄露 | 🔴 P0 | safeEnv() | ✅ |
| 4 | runCmd 拼接传 shell | 🟡 P1 | execa(shell:false) | ✅ |
| 5 | node/npx 在白名单 | 🟡 P1 | 从 SAFE_EXECUTABLES 移除 | ✅ |
| 6 | applyPatch 无回滚 | 🟡 P1 | rollbackApplied() | ✅ |
| 7 | FileMemoryStore 并发 | 🟡 P2 | 原子写入 | ✅ |
| 8 | runCommand shell:true | 🟡 P2 | 兜底转发到 runCmd | ✅ |
| 9 | any 类型 | 🟢 P3 | audit-pipeline 清理 | ✅ |

---

## 技术债务

| 问题 | 严重度 | 状态 |
|------|--------|------|
| CLI 单体文件 (~1183行) | 🟡 P2 | 已提取 config.ts + templates.ts |
| Agent Loop 状态机 | 🟡 P2 | 有 phase 字段，待显式化 |
| OS 级 sandbox | 🟢 P3 | 规划中 |
| MCP 集成 | 🟢 P3 | 类型预留 |
| Router Eval 91/91 通过 ✅ | 🟢 | 已修复 (v2.5) |
| repair_pipeline 缺少 repair fixture | 🟡 P1 | 待补充 20 条修复测试 |
| review_diff_pipeline 无 CI 集成 | 🟢 P2 | 待添加 pre-commit hook |

---

## 当前优先级

1. 🟡 CLI 拆分 (1400行 → commands/interactive/config/templates)
2. 🟡 补充 repair pipeline fixture (20 条 TS 类型错误)
3. 🟢 dscode eval router --live 持续监控
4. 🟢 补充 review_diff_pipeline 单元测试
5. 🟢 CHANGELOG.md + 贡献指南

// ============================================================
// deepseek-code-core — 主入口
// ============================================================

// Model
export { DeepSeekClient, ModelRouter } from './model/index.js';
export type { ModelClient, ChatOptions, DeepSeekConfig } from './model/index.js';
export type { ModelRouterConfig } from './model/index.js';

// Tools
export { READ_ONLY_TOOLS, WRITE_TOOLS, createToolExecutors, executeTool } from './tools/index.js';
export type { ToolContext, ToolExecutors } from './tools/index.js';

// Context
export { scanRepo, buildRepoSummary, FileMemoryStore, InMemoryStore, createStep, buildPrompt, compressSessionForResume, buildGlobalPrefix, buildRuntimePrefix, buildProjectPrefix, stableStringify, saveInteractiveState, loadInteractiveState, clearInteractiveState, buildLastAgentResult } from './context/index.js';
export type { ScanOptions, MemoryStore, PromptLayers, PromptHashes, PendingAction, InteractiveSessionState } from './context/index.js';

// Agent
export { runAgentLoop, generatePlan, continueLoop, routeInput, normalizeRouteDecision } from './agent/index.js';
export type { AgentConfig, AgentResult, LastAgentResult, RouterContext, LLMRouterClient } from './agent/index.js';

// Safety
export { PermissionManager, createDefaultPermissionConfig, filterSecrets, containsSuspiciousSecrets } from './safety/index.js';
export type { PermissionConfig } from './safety/index.js';

// Audit
export { auditTools } from './tools/audit-tools.js';
export { runAuditPipeline, formatAuditReport } from './tools/audit-pipeline.js';
export type { PipelineOptions } from './tools/audit-pipeline.js';

// Symbol Finder (AST-based)
export { findSymbolReferencesAST, toToolResult } from './tools/symbol-finder.js';
export type { SymbolReference, SymbolFindResult } from './tools/symbol-finder.js';

// URL Fetch Pipeline
export { runUrlFetchPipeline, formatUrlFetchResult } from './tools/url-fetch-pipeline.js';
export type { UrlFetchResult, UrlFetchOptions } from './tools/url-fetch-pipeline.js';
export { validateUrl } from './tools/web-search.js';
export type { UrlValidation } from './tools/web-search.js';

// Repair
export { runRepairPipeline, parseErrors, extractFilesFromTask, analyzeRootCausePattern } from './tools/repair-pipeline.js';
export type { RepairResult, ParsedError, RepairPipelineOptions } from './tools/repair-pipeline.js';

// Review Diff
export { runReviewDiffPipeline } from './tools/review-diff-pipeline.js';
export type { DiffReviewResult, DiffFinding } from './tools/review-diff-pipeline.js';

// AutoFix Loop
export { runAutoFixLoop } from './tools/autofix-loop.js';
export type { AutoFixResult, AutoFixOptions, FixAttempt } from './tools/autofix-loop.js';

// Task Eval
export { loadTaskFixtures, scoreTaskEval, generateTaskEvalReport, formatTaskEvalReport } from './tools/task-eval.js';
export type { TaskEvalCase, TaskEvalResult, TaskEvalReport, TaskEvalScore } from './tools/task-eval.js';

// Router Eval
export { evaluateRouterCase, generateEvalReport, formatEvalReport } from './agent/router-eval.js';
export type { EvalResult, EvalReport } from './agent/router-eval.js';

// Workflow
export {
  WorkflowEngine,
  validateWorkflow,
  resolveTemplate,
  resolveObject,
  evaluateExpression,
  saveWorkflowDefinition,
  loadWorkflowDefinition,
  listWorkflowDefinitions,
  deleteWorkflowDefinition,
  saveWorkflowRun,
  loadWorkflowRun,
  listWorkflowRuns,
  deleteWorkflowRun,
  BUILTIN_WORKFLOWS,
  REVIEW_DIFF_WORKFLOW,
  REPAIR_TYPESCRIPT_WORKFLOW,
  CODE_REVIEW_BASIC_WORKFLOW,
} from './workflow/index.js';
export type { ToolExecutor, PipelineExecutor, ValidationResult } from './workflow/index.js';

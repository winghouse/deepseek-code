// ============================================================
// 内置工作流 — v0 内置 3 个，覆盖真实场景
// review-diff / repair-typescript / code-review-basic
// ============================================================

import type { WorkflowDefinition } from 'deepseek-code-shared';

/**
 * 1. review-diff：检查当前 git diff 的风险点
 *
 * 流程: git_status → git_diff → CONDITION(has_diff) → review_diff pipeline → END
 */
export const REVIEW_DIFF_WORKFLOW: WorkflowDefinition = {
  schemaVersion: '0.1',
  id: 'review-diff',
  name: 'Review current git diff',
  description: '检查当前 git diff 的风险点（API breaking change / 密钥泄露 / 危险代码等）',
  inputs: {
    severity: { type: 'string', default: 'medium', description: '最低报告严重度: low/medium/high' },
  },
  budgets: { maxNodes: 10, maxToolCalls: 10, timeoutMs: 120_000 },
  nodes: [
    { id: 'begin', type: 'BEGIN' },
    { id: 'git_status', type: 'TOOL', tool: 'git_status', name: '检查 Git 状态' },
    { id: 'git_diff', type: 'TOOL', tool: 'git_diff', name: '获取 Diff' },
    { id: 'has_diff', type: 'CONDITION', name: '是否有变更', expression: "${git_status.result.metadata.hasUncommittedChanges} == true" },
    { id: 'review', type: 'PIPELINE', pipeline: 'review_diff', name: '审查 Diff', params: { diff: '${git_diff.result.content}' } },
    { id: 'end', type: 'END', name: '完成', params: { status: '${review.result.status}', findings: '${review.result.findings}' } },
  ],
  edges: [
    { from: 'begin', to: 'git_status' },
    { from: 'git_status', to: 'git_diff' },
    { from: 'git_diff', to: 'has_diff' },
    { from: 'has_diff', to: 'review', condition: 'true' },
    { from: 'has_diff', to: 'end', condition: 'false' },
    { from: 'review', to: 'end' },
  ],
};

/**
 * 2. repair-typescript：解析错误 → 定位文件 → 修复
 *
 * 流程: search_code(error snippet) → read_file(定位) → repair pipeline → END
 */
export const REPAIR_TYPESCRIPT_WORKFLOW: WorkflowDefinition = {
  schemaVersion: '0.1',
  id: 'repair-typescript',
  name: 'Repair TypeScript errors',
  description: '根据 TypeScript 编译错误自动定位并生成修复方案',
  inputs: {
    error: { type: 'string', required: true, description: '编译错误文本' },
    file: { type: 'string', required: false, description: '已知问题文件路径' },
  },
  budgets: { maxNodes: 15, maxToolCalls: 15, timeoutMs: 180_000 },
  nodes: [
    { id: 'begin', type: 'BEGIN' },
    { id: 'search_error', type: 'TOOL', tool: 'search_code', name: '搜索错误位置', params: { pattern: '${input.error}', maxResults: 5 } },
    { id: 'read_file', type: 'TOOL', tool: 'read_file', name: '读取问题文件', params: { filePath: '${input.file}' } },
    { id: 'repair', type: 'PIPELINE', pipeline: 'repair', name: '执行修复', params: { error: '${input.error}', fileContent: '${read_file.result.content}', context: '${search_error.result}' } },
    { id: 'end', type: 'END', name: '完成', params: { patch: '${repair.result.patch}', analysis: '${repair.result.analysis}' } },
  ],
  edges: [
    { from: 'begin', to: 'search_error' },
    { from: 'search_error', to: 'read_file' },
    { from: 'read_file', to: 'repair' },
    { from: 'repair', to: 'end' },
  ],
};

/**
 * 3. code-review-basic：扫描项目 → 分类审查 → 输出报告
 *
 * 流程: list_files → search_code(关键模式) → audit pipeline → END
 */
export const CODE_REVIEW_BASIC_WORKFLOW: WorkflowDefinition = {
  schemaVersion: '0.1',
  id: 'code-review-basic',
  name: 'Basic code review',
  description: '扫描项目结构，检查安全/类型/测试/配置等维度',
  inputs: {
    scope: { type: 'string', default: 'standard', description: '审查范围: quick/standard/deep' },
  },
  budgets: { maxNodes: 20, maxToolCalls: 20, timeoutMs: 300_000 },
  nodes: [
    { id: 'begin', type: 'BEGIN' },
    { id: 'list_files', type: 'TOOL', tool: 'list_files', name: '列出项目文件' },
    { id: 'search_secrets', type: 'TOOL', tool: 'search_code', name: '搜索密钥泄露', params: { pattern: '(api_key|apiKey|secret|token|password)\\s*=\\s*[\'"][^\'"]+[\'"]', maxResults: 10 } },
    { id: 'search_dangerous', type: 'TOOL', tool: 'search_code', name: '搜索危险代码', params: { pattern: '(eval|innerHTML|dangerouslySetInnerHTML|shell:\\s*true)', maxResults: 10 } },
    { id: 'search_only', type: 'TOOL', tool: 'search_code', name: '搜索 .only 残留', params: { pattern: '\\.only\\(', maxResults: 10 } },
    { id: 'audit', type: 'PIPELINE', pipeline: 'audit', name: '执行审查', params: { scope: '${input.scope}' } },
    { id: 'end', type: 'END', name: '完成', params: {
      audit_report: '${audit.result}',
      secrets_found: '${search_secrets.result.content}',
      dangerous_code: '${search_dangerous.result.content}',
      only_残留: '${search_only.result.content}',
    } },
  ],
  edges: [
    { from: 'begin', to: 'list_files' },
    { from: 'list_files', to: 'search_secrets' },
    { from: 'search_secrets', to: 'search_dangerous' },
    { from: 'search_dangerous', to: 'search_only' },
    { from: 'search_only', to: 'audit' },
    { from: 'audit', to: 'end' },
  ],
};

/** 所有内置工作流 */
export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [
  REVIEW_DIFF_WORKFLOW,
  REPAIR_TYPESCRIPT_WORKFLOW,
  CODE_REVIEW_BASIC_WORKFLOW,
];

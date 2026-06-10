// ============================================================
// 工作流持久化 — 定义 + 运行记录
// 存储位置: .deepseek-code/workflows/
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowDefinition, WorkflowRun } from 'deepseek-code-shared';

/** 获取 workflow 存储目录 */
function getWorkflowDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.deepseek-code', 'workflows');
}

function getDefinitionsDir(workspaceRoot: string): string {
  return path.join(getWorkflowDir(workspaceRoot), 'definitions');
}

function getRunsDir(workspaceRoot: string): string {
  return path.join(getWorkflowDir(workspaceRoot), 'runs');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---- 工作流定义 ----

/** 保存工作流定义 */
export function saveWorkflowDefinition(
  workspaceRoot: string,
  def: WorkflowDefinition,
): void {
  const dir = getDefinitionsDir(workspaceRoot);
  ensureDir(dir);
  const filePath = path.join(dir, `${def.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(def, null, 2), 'utf-8');
}

/** 加载工作流定义 */
export function loadWorkflowDefinition(
  workspaceRoot: string,
  workflowId: string,
): WorkflowDefinition | null {
  const filePath = path.join(getDefinitionsDir(workspaceRoot), `${workflowId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** 列出所有已保存的工作流定义 */
export function listWorkflowDefinitions(workspaceRoot: string): WorkflowDefinition[] {
  const dir = getDefinitionsDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  const defs: WorkflowDefinition[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const def = loadWorkflowDefinition(workspaceRoot, entry.replace('.json', ''));
    if (def) defs.push(def);
  }
  return defs;
}

/** 删除工作流定义 */
export function deleteWorkflowDefinition(workspaceRoot: string, workflowId: string): boolean {
  const filePath = path.join(getDefinitionsDir(workspaceRoot), `${workflowId}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

// ---- 运行记录 ----

/** 保存运行记录 */
export function saveWorkflowRun(workspaceRoot: string, run: WorkflowRun): void {
  const dir = getRunsDir(workspaceRoot);
  ensureDir(dir);
  const filePath = path.join(dir, `${run.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(run, null, 2), 'utf-8');
}

/** 加载运行记录 */
export function loadWorkflowRun(
  workspaceRoot: string,
  runId: string,
): WorkflowRun | null {
  const filePath = path.join(getRunsDir(workspaceRoot), `${runId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data;
  } catch {
    return null;
  }
}

/** 列出所有运行记录，按时间倒序 */
export function listWorkflowRuns(workspaceRoot: string): WorkflowRun[] {
  const dir = getRunsDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  const runs: WorkflowRun[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const run = loadWorkflowRun(workspaceRoot, entry.replace('.json', ''));
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** 删除运行记录 */
export function deleteWorkflowRun(workspaceRoot: string, runId: string): boolean {
  const filePath = path.join(getRunsDir(workspaceRoot), `${runId}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

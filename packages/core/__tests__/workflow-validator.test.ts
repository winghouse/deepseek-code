// ============================================================
// 工作流校验测试
// ============================================================

import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '../src/workflow/validator.js';
import type { WorkflowDefinition } from 'deepseek-code-shared';

/** 最小合法工作流 */
function minimalWorkflow(): WorkflowDefinition {
  return {
    schemaVersion: '0.1',
    id: 'test-wf',
    name: 'Test Workflow',
    nodes: [
      { id: 'begin', type: 'BEGIN' },
      { id: 'end', type: 'END' },
    ],
    edges: [
      { from: 'begin', to: 'end' },
    ],
  };
}

describe('validateWorkflow', () => {
  // ---- 基础校验 ----
  describe('基础字段', () => {
    it('合法工作流 → valid', () => {
      const result = validateWorkflow(minimalWorkflow());
      expect(result.valid).toBe(true);
    });
    it('缺少 id → 报错', () => {
      const wf = { ...minimalWorkflow(), id: '' };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('id'))).toBe(true);
    });
    it('缺少 name → 报错', () => {
      const wf = { ...minimalWorkflow(), name: '' };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('name'))).toBe(true);
    });
    it('schemaVersion != "0.1" → 报错', () => {
      const wf = { ...minimalWorkflow(), schemaVersion: '0.2' as any };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('schemaVersion'))).toBe(true);
    });
    it('空节点列表 → 报错', () => {
      const result = validateWorkflow({ schemaVersion: '0.1', id: 'x', name: 'x', nodes: [], edges: [] });
      expect(result.valid).toBe(false);
    });
  });

  // ---- BEGIN/END ----
  describe('BEGIN/END 校验', () => {
    it('缺少 BEGIN → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [{ id: 'end', type: 'END' }];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('BEGIN'))).toBe(true);
    });
    it('缺少 END → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [{ id: 'begin', type: 'BEGIN' }];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('END'))).toBe(true);
    });
    it('多个 BEGIN → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [
        { id: 'begin1', type: 'BEGIN' },
        { id: 'begin2', type: 'BEGIN' },
        { id: 'end', type: 'END' },
      ];
      wf.edges = [
        { from: 'begin1', to: 'end' },
        { from: 'begin2', to: 'end' },
      ];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('BEGIN'))).toBe(true);
    });
  });

  // ---- 节点 ID ----
  describe('节点 ID', () => {
    it('重复 ID → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [
        { id: 'dup', type: 'BEGIN' },
        { id: 'dup', type: 'END' },
      ];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('重复'))).toBe(true);
    });
    it('缺少 id → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [
        { id: '', type: 'BEGIN' },
        { id: 'end', type: 'END' },
      ];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('id'))).toBe(true);
    });
  });

  // ---- 节点类型 ----
  describe('节点类型', () => {
    it('非法节点类型 → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes.push({ id: 'bad', type: 'INVALID' as any });
      wf.edges.push({ from: 'end', to: 'bad' });
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('类型不合法'))).toBe(true);
    });
    it('TOOL 节点缺少 tool → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [
        { id: 'begin', type: 'BEGIN' },
        { id: 'step1', type: 'TOOL', name: 'test' },
        { id: 'end', type: 'END' },
      ];
      wf.edges = [
        { from: 'begin', to: 'step1' },
        { from: 'step1', to: 'end' },
      ];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('缺少 tool'))).toBe(true);
    });
    it('PIPELINE 节点缺少 pipeline → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [
        { id: 'begin', type: 'BEGIN' },
        { id: 'step1', type: 'PIPELINE', name: 'test' },
        { id: 'end', type: 'END' },
      ];
      wf.edges = [
        { from: 'begin', to: 'step1' },
        { from: 'step1', to: 'end' },
      ];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('缺少 pipeline'))).toBe(true);
    });
    it('PIPELINE 使用未知管线 → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [
        { id: 'begin', type: 'BEGIN' },
        { id: 'step1', type: 'PIPELINE', pipeline: 'unknown_pipeline', name: 'test' },
        { id: 'end', type: 'END' },
      ];
      wf.edges = [
        { from: 'begin', to: 'step1' },
        { from: 'step1', to: 'end' },
      ];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('未知管线'))).toBe(true);
    });
    it('CONDITION 节点缺少 expression → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [
        { id: 'begin', type: 'BEGIN' },
        { id: 'cond', type: 'CONDITION', name: 'test' },
        { id: 'end', type: 'END' },
      ];
      wf.edges = [
        { from: 'begin', to: 'cond' },
        { from: 'cond', to: 'end' },
      ];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('缺少 expression'))).toBe(true);
    });
  });

  // ---- 边校验 ----
  describe('边校验', () => {
    it('引用不存在的源节点 → 报错', () => {
      const wf = minimalWorkflow();
      wf.edges = [{ from: 'ghost', to: 'end' }];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('不存在') && e.includes('ghost'))).toBe(true);
    });
    it('引用不存在的目标节点 → 报错', () => {
      const wf = minimalWorkflow();
      wf.edges = [{ from: 'begin', to: 'ghost' }];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('不存在') && e.includes('ghost'))).toBe(true);
    });
    it('空边列表 → 报错', () => {
      const wf = { ...minimalWorkflow(), edges: [] };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('边'))).toBe(true);
    });
  });

  // ---- DAG 无环 ----
  describe('无环检测', () => {
    it('简单环路 → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [
        { id: 'begin', type: 'BEGIN' },
        { id: 'a', type: 'TOOL', tool: 'list_files' },
        { id: 'b', type: 'TOOL', tool: 'read_file' },
        { id: 'end', type: 'END' },
      ];
      wf.edges = [
        { from: 'begin', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },  // 回边
        { from: 'b', to: 'end' },
      ];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('环路'))).toBe(true);
    });
    it('自环 → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [
        { id: 'begin', type: 'BEGIN' },
        { id: 'self', type: 'TOOL', tool: 'list_files' },
        { id: 'end', type: 'END' },
      ];
      wf.edges = [
        { from: 'begin', to: 'self' },
        { from: 'self', to: 'self' }, // 自环
        { from: 'self', to: 'end' },
      ];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('环路'))).toBe(true);
    });
  });

  // ---- 孤立节点 ----
  describe('孤立节点', () => {
    it('孤立节点 → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes.push({ id: 'orphan', type: 'TOOL', tool: 'list_files' });
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('孤立') && e.includes('orphan'))).toBe(true);
    });
    it('BEGIN/END 不算孤立', () => {
      const wf = minimalWorkflow();
      // only BEGIN and END — both excluded from isolated check
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(true);
    });
  });

  // ---- 模板变量引用 ----
  describe('模板变量引用检查', () => {
    it('引用不存在的节点 → 报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [
        { id: 'begin', type: 'BEGIN' },
        { id: 'step1', type: 'TOOL', tool: 'read_file', params: { prompt: '${ghost.result.data}' } },
        { id: 'end', type: 'END' },
      ];
      wf.edges = [
        { from: 'begin', to: 'step1' },
        { from: 'step1', to: 'end' },
      ];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('引用') && e.includes('ghost'))).toBe(true);
    });
    it('${input.xxx} 不报错', () => {
      const wf = minimalWorkflow();
      wf.nodes = [
        { id: 'begin', type: 'BEGIN' },
        { id: 'step1', type: 'TOOL', tool: 'read_file', params: { filePath: '${input.target}' } },
        { id: 'end', type: 'END' },
      ];
      wf.edges = [
        { from: 'begin', to: 'step1' },
        { from: 'step1', to: 'end' },
      ];
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(true);
    });
  });

  // ---- 预算 ----
  describe('预算校验', () => {
    it('maxNodes < 1 → 报错', () => {
      const wf = { ...minimalWorkflow(), budgets: { maxNodes: 0 } };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('maxNodes'))).toBe(true);
    });
    it('timeoutMs < 1000 → 报错', () => {
      const wf = { ...minimalWorkflow(), budgets: { timeoutMs: 500 } };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('timeoutMs'))).toBe(true);
    });
  });

  // ---- 完整工作流 ----
  describe('完整工作流', () => {
    it('review-diff 模式 → valid', () => {
      const wf: WorkflowDefinition = {
        schemaVersion: '0.1',
        id: 'review-diff',
        name: 'Review Diff',
        nodes: [
          { id: 'begin', type: 'BEGIN' },
          { id: 'git_diff', type: 'TOOL', tool: 'git_diff' },
          { id: 'has_diff', type: 'CONDITION', expression: '${git_diff.result.hasChanges} == true' },
          { id: 'review', type: 'PIPELINE', pipeline: 'review_diff' },
          { id: 'end', type: 'END' },
        ],
        edges: [
          { from: 'begin', to: 'git_diff' },
          { from: 'git_diff', to: 'has_diff' },
          { from: 'has_diff', to: 'review', condition: 'true' },
          { from: 'has_diff', to: 'end', condition: 'false' },
          { from: 'review', to: 'end' },
        ],
      };
      const result = validateWorkflow(wf);
      expect(result.valid).toBe(true);
    });
  });
});

# Router --live 评测基线

> 运行: `dscode eval router --live --suite external-resource`

## 目标

- LLM Router 分类准确率 ≥ 90%
- P0 failures = 0
- 单次路由延迟 < 3s

## 当前基线

| 指标 | 值 | 日期 |
|------|-----|------|
| 离线评测 | 101/101 (100%) | 2026-06-10 |
| Heuristic 命中率 | 80% | 2026-06-10 |
| --live LLM 准确率 | 待测 | - |
| P0 失败 | 0 | 2026-06-10 |

## 回归检查项

- [ ] Router Eval offline: 101 pass
- [ ] Router Eval --live: P0=0
- [ ] external-resource suite: all pass
- [ ] contextual suite: all pass

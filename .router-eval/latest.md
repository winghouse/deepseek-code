# Router Eval Report

| Metric | Value |
|--------|-------|
| Total | 44 |
| Passed | 43 |
| Failed | 1 |
| Intent Accuracy | 100% |
| Execution Accuracy | 98% |
| Scan Accuracy | 100% |
| Tool Invariant | 100% |
| Heuristic Hit Rate | 59% |
| LLM Fallback | 10 |
| P0 Failures | 0 |
| P1 Failures | 1 |
| P2 Failures | 0 |

## Suite Breakdown

| agent-tasks | 7/7 (100%) |
| audit-review | 5/6 (83%) |
| command | 8/8 (100%) |
| contextual | 5/5 (100%) |
| direct-chat | 5/5 (100%) |
| regression | 4/4 (100%) |
| safety-adversarial | 5/5 (100%) |
| tool-verification | 4/4 (100%) |

## Confusion Matrix

| llm_direct → unknown | 1 |

## Failures

### audit-004 [P1]

Expected: llm_direct→llm_direct
Actual: unknown→local_action
- execution: expected llm_direct, got local_action

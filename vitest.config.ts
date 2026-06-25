import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/__tests__/**/*.test.ts', '.evals/tasks/*.test.ts', '.evals/tasks/live-e2e.ts'],
    exclude: ['**/node_modules/**', '.evals/tasks/generate-fixtures.ts', '.evals/fixtures/**', '.evals/tasks/eval-runner.ts', '.evals/tasks/pipeline-bench.ts', '**/router-eval.test.ts', '.evals/tasks/cache-bench.test.ts', '.evals/tasks/cache-quality.test.ts', '.evals/tasks/repair-bench.test.ts'],
    // NodeNext 模块解析
    pool: 'forks',
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/__tests__/**/*.test.ts', '.evals/tasks/**/*.ts'],
    exclude: ['.evals/tasks/generate-fixtures.ts', '.evals/fixtures/**', '.evals/tasks/eval-runner.ts', '.evals/tasks/agent-e2e.test.ts', '.evals/tasks/live-e2e.ts', '**/router-eval.test.ts'],
    // NodeNext 模块解析
    pool: 'forks',
  },
});

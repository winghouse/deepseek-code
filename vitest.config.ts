import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/__tests__/**/*.test.ts', '.evals/**/*.ts'],
    // NodeNext 模块解析
    pool: 'forks',
  },
});

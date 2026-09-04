import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    pool: 'vmThreads',
    maxWorkers: 1,
  },
});

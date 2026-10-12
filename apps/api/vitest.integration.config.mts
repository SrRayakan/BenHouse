import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    setupFiles: ['test/verified-database.mjs'],
    pool: 'vmThreads',
    maxWorkers: 1,
  },
});

import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts', 'entrypoints/**/*.ts', 'workers/**/*.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
});

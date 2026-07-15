import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(
        new URL(
          './apps/obsidian-plugin/src/test/obsidian.mock.ts',
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    passWithNoTests: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['apps/**/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/fixtures/**'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});

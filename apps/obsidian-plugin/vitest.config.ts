import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(
        new URL('./src/test/obsidian.mock.ts', import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      exclude: ['src/**/*.test.ts', 'src/test/**'],
      include: ['src/main.ts', 'src/storage/**/*.ts'],
      provider: 'v8',
      reporter: ['text'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    environment: 'node',
    include: ['src/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
  },
});

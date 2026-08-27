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
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/fixtures/**',
        // Platform glue binding real Obsidian runtime APIs (requestUrl, Vault,
        // workspace events, saveData). Exercised in the live pilot rather than
        // headless, and already excluded by the plugin's own config, counting
        // it here made the two disagree and left the branch threshold with
        // under a point of headroom, so any edit to this layer would have read
        // as an accidental regression rather than known debt.
        'apps/obsidian-plugin/src/runtime/obsidian-adapters.ts',
        'apps/obsidian-plugin/src/runtime/adapters/**',
        'apps/obsidian-plugin/src/test/**',
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});

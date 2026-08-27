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
      exclude: [
        'src/**/*.test.ts',
        'src/test/**',
        // Platform glue that binds real Obsidian runtime APIs (requestUrl,
        // Vault, workspace events, saveData). Exercised in the live pilot,
        // not in headless unit tests; the logic it wires is tested per module.
        // `obsidian-adapters.ts` is now a façade over `runtime/adapters/**`,
        // which holds exactly the same platform glue, both stay excluded so
        // the split changed no coverage, only file boundaries.
        'src/runtime/obsidian-adapters.ts',
        'src/runtime/adapters/**',
      ],
      // The whole plugin, minus the exclusions above. The previous list named
      // main.ts, runtime/ and storage/ only, written when those were the whole
      // plugin, and never widened as ui/, sync/, onboarding/, attribution/,
      // obsidian/ and activity/ grew to 7515 lines around it. Those directories
      // measured 88-91% when checked by hand, so this widening asserts what was
      // already true; the point is that a regression now fails the gate instead
      // of going unnoticed until someone runs coverage manually.
      include: ['src/**/*.ts'],
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

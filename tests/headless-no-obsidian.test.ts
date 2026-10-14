/**
 * The headless agent client (plan 014) runs in plain Node: nothing it imports
 * may import `obsidian`, which only exists inside the Obsidian app. Vitest
 * aliases `obsidian` to a mock, so only a real bundle can catch a stray import.
 */
import { join } from 'node:path';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('headless agent client', () => {
  it('bundles for Node without a single import of obsidian', async () => {
    const result = await build({
      entryPoints: [join(__dirname, '..', 'apps', 'obsidian-plugin', 'src', 'headless', 'agent.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const importers = Object.entries(result.metafile.inputs)
      .filter(([, input]) => input.imports.some((imported) => imported.path === 'obsidian'))
      .map(([file]) => file);
    expect(importers).toEqual([]);
  }, 30_000);
});

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageDirectory = fileURLToPath(new URL('.', import.meta.url));
const outputPath = fileURLToPath(new URL('main.js', import.meta.url));

await build({
  absWorkingDir: packageDirectory,
  banner: {
    js: '/* Havemind — Apache-2.0 */',
  },
  bundle: true,
  entryPoints: ['src/main.ts'],
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
  ],
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'warning',
  outfile: outputPath,
  platform: 'browser',
  sourcemap: false,
  target: 'es2020',
  treeShaking: true,
});

const output = await readFile(outputPath, 'utf8');
if (/\b(?:node:|process\.|require\(['"](?:fs|path|electron)['"]\))/.test(output)) {
  throw new Error('Plugin output contains a forbidden Node or Electron runtime API.');
}

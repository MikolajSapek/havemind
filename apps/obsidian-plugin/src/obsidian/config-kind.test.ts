import { describe, expect, it } from 'vitest';

import { classifyVaultPath } from './vault-adapter';

/**
 * Kind selection for `.obsidian/` config paths: the mirror does NOT force every
 * config file through the text path. Text config → text/'markdown' kind, a
 * binary asset → the base64 binary path, an unknown binary extension stays
 * excluded-with-notice so raw binary is never corrupted by canonicalisation.
 */
describe('classifyVaultPath — .obsidian config kind selection', () => {
  it.each([
    ['.obsidian/appearance.json', 'markdown'],
    ['.obsidian/app.json', 'markdown'],
    ['.obsidian/snippets/tweaks.css', 'markdown'],
    ['.obsidian/plugins/dataview/main.js', 'markdown'],
    ['.obsidian/themes/Minimal/theme.css', 'markdown'],
  ] as const)('carries text config %s as the text kind', (path, kind) => {
    const classified = classifyVaultPath(path);
    expect(classified.eligible).toBe(true);
    expect(classified.eligible && classified.kind).toBe(kind);
  });

  it.each([
    '.obsidian/themes/Minimal/preview.png',
    '.obsidian/themes/Minimal/banner.jpg',
    '.obsidian/plugins/dataview/screenshot.gif',
  ])('carries a binary config asset %s as the binary kind', (path) => {
    const classified = classifyVaultPath(path);
    expect(classified.eligible).toBe(true);
    expect(classified.eligible && classified.kind).toBe('binary');
  });

  it.each([
    '.obsidian/plugins/dataview/lib.wasm',
    '.obsidian/plugins/dataview/binary.node',
  ])('excludes an unknown binary config extension %s (never text)', (path) => {
    expect(classifyVaultPath(path).eligible).toBe(false);
  });

  it.each([
    '.obsidian/plugins/dataview/data.json',
    '.obsidian/plugins/havemind-sync/main.js',
    '.obsidian/community-plugins.json',
    '.obsidian/workspace.json',
  ])('never classifies a denylisted config path %s as eligible', (path) => {
    expect(classifyVaultPath(path).eligible).toBe(false);
  });
});

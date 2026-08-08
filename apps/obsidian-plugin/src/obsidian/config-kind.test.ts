import { describe, expect, it } from 'vitest';

import { classifyVaultPath } from './vault-adapter';

/**
 * Kind selection for the `.obsidian/` APPEARANCE ALLOWLIST: an admitted config
 * path does not automatically ride the text path. Text config → text/'markdown'
 * kind, a binary theme asset → the base64 binary path. Anything the allowlist
 * does not admit — plugin code above all — is not eligible at all.
 */
describe('classifyVaultPath — .obsidian config kind selection', () => {
  it.each([
    ['.obsidian/appearance.json', 'markdown'],
    ['.obsidian/app.json', 'markdown'],
    ['.obsidian/hotkeys.json', 'markdown'],
    ['.obsidian/core-plugins.json', 'markdown'],
    ['.obsidian/graph.json', 'markdown'],
    ['.obsidian/snippets/tweaks.css', 'markdown'],
    ['.obsidian/themes/Minimal/theme.css', 'markdown'],
    ['.obsidian/themes/Minimal/manifest.json', 'markdown'],
  ] as const)('carries text config %s as the text kind', (path, kind) => {
    const classified = classifyVaultPath(path);
    expect(classified.eligible).toBe(true);
    expect(classified.eligible && classified.kind).toBe(kind);
  });

  it.each([
    '.obsidian/themes/Minimal/preview.png',
    '.obsidian/themes/Minimal/banner.jpg',
  ])('carries a binary theme asset %s as the binary kind', (path) => {
    const classified = classifyVaultPath(path);
    expect(classified.eligible).toBe(true);
    expect(classified.eligible && classified.kind).toBe('binary');
  });

  it.each([
    '.obsidian/themes/Minimal/lib.wasm',
    '.obsidian/themes/Minimal/font.woff2',
    '.obsidian/themes/Minimal/binary.node',
  ])(
    'excludes a config extension outside the allowlist %s (never text)',
    (path) => {
      expect(classifyVaultPath(path).eligible).toBe(false);
    },
  );

  it.each([
    // FINDING 2: plugin code and plugin state, in full — no exceptions.
    '.obsidian/plugins/dataview/main.js',
    '.obsidian/plugins/dataview/manifest.json',
    '.obsidian/plugins/dataview/styles.css',
    '.obsidian/plugins/dataview/data.json',
    '.obsidian/plugins/havemind-sync/main.js',
    // Registry, per-machine layout and unlisted config: default-deny.
    '.obsidian/community-plugins.json',
    '.obsidian/workspace.json',
    '.obsidian/types.json',
    // FINDING 9: exact `data.json` segment, inside an allowed subtree.
    '.obsidian/themes/Minimal/data.json',
    // Themes are CSS-only in Obsidian — never a JS drop site.
    '.obsidian/themes/Minimal/evil.js',
  ])('never classifies a non-allowlisted config path %s as eligible', (path) => {
    expect(classifyVaultPath(path).eligible).toBe(false);
  });

  it('still admits a lookalike basename inside an allowed subtree (finding 9)', () => {
    const classified = classifyVaultPath('.obsidian/themes/Minimal/metadata.json');
    expect(classified.eligible).toBe(true);
    expect(classified.eligible && classified.kind).toBe('markdown');
  });
});

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { isSyncableConfigPath } from './appearance-scope.js';
import { canonicalizeVaultPath, isReservedVaultPath } from './canonicalization.js';

describe('isSyncableConfigPath — mirror .obsidian minus denylist', () => {
  it.each([
    '.obsidian/appearance.json',
    '.obsidian/app.json',
    '.obsidian/hotkeys.json',
    '.obsidian/core-plugins.json',
    '.obsidian/snippets/tweaks.css',
    '.obsidian/themes/Minimal/theme.css',
    '.obsidian/themes/Minimal/manifest.json',
    '.obsidian/plugins/dataview/main.js',
    '.obsidian/plugins/dataview/manifest.json',
    '.obsidian/plugins/dataview/styles.css',
  ])('mirrors allowed .obsidian config path %s', (path) => {
    expect(isSyncableConfigPath(path)).toBe(true);
  });

  it.each([
    '.obsidian/plugins/dataview/data.json',
    '.obsidian/plugins/havemind-sync/data.json',
    '.obsidian/plugins/havemind-sync/main.js',
    '.obsidian/workspace.json',
    '.obsidian/workspace-mobile.json',
    '.obsidian/community-plugins.json',
    '.obsidian/data.json',
  ])('denylist wins for %s', (path) => {
    expect(isSyncableConfigPath(path)).toBe(false);
  });

  it.each(['notes/Daily.md', 'README.md', '.trash/x.md', 'Havemind Conflicts/y.md'])(
    'returns false for a path not under .obsidian/: %s',
    (path) => {
      expect(isSyncableConfigPath(path)).toBe(false);
    },
  );

  it('property: no string containing "data.json" ever returns true', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (prefix, suffix) => {
        expect(isSyncableConfigPath(`${prefix}data.json${suffix}`)).toBe(false);
      }),
    );
  });
});

describe('canonicalizeVaultPath — .obsidian mirror exception', () => {
  it.each([
    '.obsidian/appearance.json',
    '.obsidian/core-plugins.json',
    '.obsidian/snippets/tweaks.css',
    '.obsidian/plugins/dataview/main.js',
  ])('no longer treats a mirrored config path as reserved: %s', (path) => {
    expect(isReservedVaultPath(path)).toBe(false);
    expect(canonicalizeVaultPath(path)).toBe(path);
  });

  it.each([
    '.obsidian/workspace.json',
    '.obsidian/community-plugins.json',
    '.obsidian/plugins/havemind-sync/main.js',
    '.obsidian/plugins/dataview/data.json',
    '.trash/Deleted.md',
    'Havemind Conflicts/Plan--conflict.md',
  ])('keeps denylisted, .trash and conflicts reserved: %s', (path) => {
    expect(isReservedVaultPath(path)).toBe(true);
    expect(() => canonicalizeVaultPath(path)).toThrow(/reserved/i);
  });
});

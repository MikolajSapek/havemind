import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { isSyncableConfigPath } from './appearance-scope.js';
import { canonicalizeVaultPath, isReservedVaultPath } from './canonicalization.js';

describe('isSyncableConfigPath, explicit appearance allowlist', () => {
  it.each([
    '.obsidian/appearance.json',
    '.obsidian/app.json',
    '.obsidian/hotkeys.json',
    '.obsidian/core-plugins.json',
    // Graph view settings, node colour groups included, a stated user
    // requirement, and settings-only JSON with no code path.
    '.obsidian/graph.json',
    '.obsidian/snippets/tweaks.css',
    '.obsidian/themes/Minimal/theme.css',
    '.obsidian/themes/Minimal/manifest.json',
    // FINDING 9: an exact-segment `data.json` match must not swallow every
    // lookalike basename inside an allowed subtree.
    '.obsidian/themes/Minimal/metadata.json',
    '.obsidian/themes/Minimal/mydata.json',
    '.obsidian/themes/Some Theme/theme.css',
    '.obsidian/themes/Minimal/preview.png',
  ])('admits allowlisted appearance path %s', (path) => {
    expect(isSyncableConfigPath(path)).toBe(true);
  });

  it.each([
    // FINDING 2, foreign plugin CODE must never cross the boundary: mirroring
    // it lets any member replace another member's installed plugin, which is
    // remote code execution on the next Obsidian reload.
    '.obsidian/plugins/dataview/main.js',
    '.obsidian/plugins/dataview/manifest.json',
    '.obsidian/plugins/dataview/styles.css',
    '.obsidian/plugins/dataview/data.json',
    '.obsidian/plugins/foo/data.json',
    '.obsidian/plugins/havemind-sync/main.js',
    '.obsidian/plugins/havemind-sync/data.json',
    // Registry / per-machine / unlisted config: default-deny.
    '.obsidian/community-plugins.json',
    '.obsidian/workspace.json',
    '.obsidian/workspace-mobile.json',
    '.obsidian/data.json',
    '.obsidian/Imported.md',
    // Exact-segment `data.json` still wins inside an allowed subtree.
    '.obsidian/themes/Minimal/data.json',
    '.obsidian/snippets/data.json',
    // Themes are CSS-only in Obsidian; a theme folder is never a JS drop site.
    '.obsidian/themes/Minimal/evil.js',
    '.obsidian/snippets/evil.js',
    // Traversal never re-enters through an allowed prefix.
    '.obsidian/themes/../plugins/dataview/styles.css',
    '.obsidian/snippets/../plugins/dataview/main.js',
  ])('denies out-of-allowlist path %s', (path) => {
    expect(isSyncableConfigPath(path)).toBe(false);
  });

  it.each(['notes/Daily.md', 'README.md', '.trash/x.md', 'Havemind Conflicts/y.md'])(
    'returns false for a path not under .obsidian/: %s',
    (path) => {
      expect(isSyncableConfigPath(path)).toBe(false);
    },
  );

  it('property: no path under .obsidian/plugins/ is ever syncable', () => {
    fc.assert(
      fc.property(fc.string(), (suffix) => {
        expect(isSyncableConfigPath(`.obsidian/plugins/${suffix}`)).toBe(false);
        expect(isSyncableConfigPath(`.obsidian\\plugins\\${suffix}`)).toBe(false);
      }),
    );
  });

  it('property: a `data.json` path SEGMENT is never syncable', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('.obsidian/themes/Minimal', '.obsidian/snippets'),
        (parent) => {
          expect(isSyncableConfigPath(`${parent}/data.json`)).toBe(false);
        },
      ),
    );
  });
});

describe('canonicalizeVaultPath, .obsidian appearance-allowlist exception', () => {
  it.each([
    '.obsidian/appearance.json',
    '.obsidian/core-plugins.json',
    '.obsidian/snippets/tweaks.css',
    '.obsidian/themes/Minimal/theme.css',
  ])('no longer treats an allowlisted config path as reserved: %s', (path) => {
    expect(isReservedVaultPath(path)).toBe(false);
    expect(canonicalizeVaultPath(path)).toBe(path);
  });

  it.each([
    '.obsidian/workspace.json',
    '.obsidian/community-plugins.json',
    '.obsidian/plugins/dataview/main.js',
    '.obsidian/plugins/havemind-sync/main.js',
    '.obsidian/plugins/dataview/data.json',
    '.obsidian/themes/Minimal/data.json',
    '.trash/Deleted.md',
    'Havemind Conflicts/Plan--conflict.md',
  ])('keeps every non-allowlisted, .trash and conflicts path reserved: %s', (path) => {
    expect(isReservedVaultPath(path)).toBe(true);
    expect(() => canonicalizeVaultPath(path)).toThrow(/reserved/i);
  });
});

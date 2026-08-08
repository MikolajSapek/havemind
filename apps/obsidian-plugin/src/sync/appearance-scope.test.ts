import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { isSyncableConfigPath } from './appearance-scope';

describe('isSyncableConfigPath — explicit appearance allowlist', () => {
  it.each([
    '.obsidian/appearance.json',
    '.obsidian/app.json',
    '.obsidian/hotkeys.json',
    '.obsidian/core-plugins.json',
    // Graph view settings, node colour groups included — a stated user
    // requirement, and settings-only JSON with no code path.
    '.obsidian/graph.json',
    '.obsidian/snippets/my-theme.css',
    '.obsidian/themes/Minimal/theme.css',
    '.obsidian/themes/Some Theme/manifest.json',
    '.obsidian/themes/Minimal/metadata.json',
    '.obsidian/themes/Minimal/preview.png',
  ])('admits allowlisted appearance path %s', (path) => {
    expect(isSyncableConfigPath(path)).toBe(true);
  });

  it('normalises Windows backslash separators before matching', () => {
    expect(isSyncableConfigPath('.obsidian\\appearance.json')).toBe(true);
    expect(isSyncableConfigPath('.obsidian\\themes\\Minimal\\theme.css')).toBe(
      true,
    );
    expect(isSyncableConfigPath('.obsidian\\plugins\\dataview\\main.js')).toBe(
      false,
    );
  });
});

describe('isSyncableConfigPath — plugin code and state are never in scope', () => {
  it('rejects EVERY foreign plugin file, code included (audit #3 finding 2)', () => {
    // Mirroring a peer's plugin code would let any vault member overwrite
    // another member's installed plugin — remote code execution on reload.
    expect(isSyncableConfigPath('.obsidian/plugins/dataview/main.js')).toBe(false);
    expect(isSyncableConfigPath('.obsidian/plugins/dataview/manifest.json')).toBe(
      false,
    );
    expect(isSyncableConfigPath('.obsidian/plugins/dataview/styles.css')).toBe(
      false,
    );
  });

  it('rejects every plugin data.json (secrets), incl. our own pairing store', () => {
    expect(isSyncableConfigPath('.obsidian/plugins/dataview/data.json')).toBe(
      false,
    );
    expect(isSyncableConfigPath('.obsidian/plugins/foo/data.json')).toBe(false);
    expect(
      isSyncableConfigPath('.obsidian/plugins/havemind-sync/data.json'),
    ).toBe(false);
  });

  it('rejects the entire havemind-sync plugin folder', () => {
    expect(isSyncableConfigPath('.obsidian/plugins/havemind-sync/main.js')).toBe(
      false,
    );
    expect(
      isSyncableConfigPath('.obsidian/plugins/havemind-sync/manifest.json'),
    ).toBe(false);
  });

  it('rejects the plugin registry, per-machine layout and unlisted config', () => {
    expect(isSyncableConfigPath('.obsidian/community-plugins.json')).toBe(false);
    expect(isSyncableConfigPath('.obsidian/workspace.json')).toBe(false);
    expect(isSyncableConfigPath('.obsidian/workspace-mobile.json')).toBe(false);
    // Default-deny: anything not on the allowlist stays out, no denylist entry
    // needed for it.
    expect(isSyncableConfigPath('.obsidian/types.json')).toBe(false);
    expect(isSyncableConfigPath('.obsidian/backlink.json')).toBe(false);
    expect(isSyncableConfigPath('.obsidian/data.json')).toBe(false);
  });

  it('rejects a data.json SEGMENT inside an allowed subtree (finding 9)', () => {
    expect(isSyncableConfigPath('.obsidian/themes/Minimal/data.json')).toBe(
      false,
    );
    expect(isSyncableConfigPath('.obsidian/snippets/data.json')).toBe(false);
  });

  it('admits basenames that merely CONTAIN "data.json" (finding 9)', () => {
    // The old substring rule blocked these for no benefit; plugin secrets are
    // now excluded by the plugins subtree denial, not by a name heuristic.
    expect(isSyncableConfigPath('.obsidian/themes/Minimal/metadata.json')).toBe(
      true,
    );
    expect(isSyncableConfigPath('.obsidian/themes/Minimal/mydata.json')).toBe(
      true,
    );
  });

  it('rejects executable code inside an allowed subtree (themes are CSS-only)', () => {
    expect(isSyncableConfigPath('.obsidian/themes/Minimal/evil.js')).toBe(false);
    expect(isSyncableConfigPath('.obsidian/snippets/evil.js')).toBe(false);
    expect(isSyncableConfigPath('.obsidian/snippets/nested/tweaks.css')).toBe(
      false,
    );
  });

  it('rejects a traversal path that re-enters through an allowed prefix', () => {
    expect(
      isSyncableConfigPath('.obsidian/themes/../plugins/dataview/styles.css'),
    ).toBe(false);
    expect(
      isSyncableConfigPath('.obsidian/snippets/../plugins/dataview/main.js'),
    ).toBe(false);
  });
});

describe('isSyncableConfigPath — out of scope', () => {
  it('returns false for anything not under .obsidian/', () => {
    expect(isSyncableConfigPath('notes/Daily.md')).toBe(false);
    expect(isSyncableConfigPath('README.md')).toBe(false);
    expect(isSyncableConfigPath('.trash/x.md')).toBe(false);
    expect(isSyncableConfigPath('Havemind Conflicts/y.md')).toBe(false);
  });
});

describe('isSyncableConfigPath — property tests', () => {
  it('NO path under .obsidian/plugins/ ever returns true', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.constantFrom('/', '\\'),
        (plugin, file, sep) => {
          expect(
            isSyncableConfigPath(`.obsidian${sep}plugins${sep}${plugin}${sep}${file}`),
          ).toBe(false);
        },
      ),
    );
  });

  it('no `data.json` path segment ever returns true', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          '.obsidian/themes/Minimal',
          '.obsidian/themes/Some Theme',
          '.obsidian/snippets',
          '.obsidian',
        ),
        fc.constantFrom('/', '\\'),
        (parent, sep) => {
          expect(isSyncableConfigPath(`${parent}${sep}data.json`)).toBe(false);
        },
      ),
    );
  });

  it('an arbitrary basename under .obsidian/ is only syncable when allowlisted', () => {
    const allowed = new Set([
      'appearance.json',
      'app.json',
      'core-plugins.json',
      'graph.json',
      'hotkeys.json',
    ]);
    fc.assert(
      fc.property(
        fc
          .string()
          .filter((name) => name.length > 0 && !name.includes('/') && !name.includes('\\')),
        (name) => {
          expect(isSyncableConfigPath(`.obsidian/${name}`)).toBe(
            allowed.has(name),
          );
        },
      ),
    );
  });
});

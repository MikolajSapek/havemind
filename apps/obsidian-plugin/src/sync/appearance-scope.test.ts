import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { isSyncableConfigPath } from './appearance-scope';

describe('isSyncableConfigPath — mirror .obsidian minus denylist', () => {
  it.each([
    '.obsidian/appearance.json',
    '.obsidian/app.json',
    '.obsidian/hotkeys.json',
    '.obsidian/core-plugins.json',
    '.obsidian/snippets/my-theme.css',
    '.obsidian/themes/Minimal/theme.css',
    '.obsidian/themes/Some Theme/manifest.json',
    '.obsidian/plugins/dataview/main.js',
    '.obsidian/plugins/dataview/manifest.json',
    '.obsidian/plugins/dataview/styles.css',
  ])('mirrors allowed .obsidian config path %s', (path) => {
    expect(isSyncableConfigPath(path)).toBe(true);
  });

  it('normalises Windows backslash separators before matching', () => {
    expect(isSyncableConfigPath('.obsidian\\appearance.json')).toBe(true);
    expect(isSyncableConfigPath('.obsidian\\plugins\\dataview\\main.js')).toBe(
      true,
    );
  });
});

describe('isSyncableConfigPath — denylist wins over the mirror', () => {
  it('rejects any plugin data.json (secrets), incl. our own pairing store', () => {
    expect(isSyncableConfigPath('.obsidian/plugins/dataview/data.json')).toBe(
      false,
    );
    expect(
      isSyncableConfigPath('.obsidian/plugins/havemind-sync/data.json'),
    ).toBe(false);
  });

  it('rejects the entire havemind-sync plugin folder (belt and suspenders)', () => {
    expect(isSyncableConfigPath('.obsidian/plugins/havemind-sync/main.js')).toBe(
      false,
    );
    expect(
      isSyncableConfigPath('.obsidian/plugins/havemind-sync/manifest.json'),
    ).toBe(false);
  });

  it('rejects the enabled-plugins list so synced plugins arrive DISABLED', () => {
    expect(isSyncableConfigPath('.obsidian/community-plugins.json')).toBe(false);
  });

  it('rejects per-machine window layout', () => {
    expect(isSyncableConfigPath('.obsidian/workspace.json')).toBe(false);
    expect(isSyncableConfigPath('.obsidian/workspace-mobile.json')).toBe(false);
  });

  it('DENYLIST WINS: a data.json nested under a themes-lookalike path is still rejected', () => {
    expect(isSyncableConfigPath('.obsidian/themes/Minimal/data.json')).toBe(
      false,
    );
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
  it('no string containing "data.json" ever returns true', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.constantFrom('/', '\\', ''),
        (prefix, suffix, sep) => {
          expect(isSyncableConfigPath(`${prefix}${sep}data.json${suffix}`)).toBe(
            false,
          );
        },
      ),
    );
  });

  it('no plugins/<plugin>/data.json ever syncs, but a sibling main.js does', () => {
    const pluginName = fc
      .string()
      .filter(
        (name) =>
          name.length > 0 &&
          !name.includes('/') &&
          !name.includes('\\') &&
          !name.includes('data.json') &&
          name !== 'havemind-sync',
      );
    fc.assert(
      fc.property(pluginName, (plugin) => {
        expect(
          isSyncableConfigPath(`.obsidian/plugins/${plugin}/data.json`),
        ).toBe(false);
        expect(isSyncableConfigPath(`.obsidian/plugins/${plugin}/main.js`)).toBe(
          true,
        );
      }),
    );
  });
});

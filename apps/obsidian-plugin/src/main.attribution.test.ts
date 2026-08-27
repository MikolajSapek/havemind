/**
 * FINDING 1: the author overlay was fully implemented and fully tested, but
 * imported by nothing, `specs/001-mvp.md` promises a Live Preview editor
 * extension, Reading-view block markers and a "Show authors" action, and none of
 * the three existed. These tests pin the wiring end to end: the command and the
 * ribbon toggle one flag, both surfaces are registered exactly once, and a
 * rendered block really does get marked from the live Activity feed.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin from './main';
import {
  AUTHOR_BLOCK_CLASS,
  type ReadingViewSectionInfo,
} from './attribution/reading-view';
import type { ActivityLog, ActivityLogEntry } from './runtime/activity-log';
import type { RosterMember } from './runtime/roster';
import {
  App,
  type Command,
  createMockElement,
  type MockElement,
  type PluginManifest,
  registrationState,
  resetObsidianMock,
} from './test/obsidian.mock';

const manifest: PluginManifest = {
  author: 'Mikolaj Pawel Sapek',
  description: 'Synchronize shared Markdown vaults with durable history.',
  id: 'havemind-sync',
  isDesktopOnly: true,
  minAppVersion: '1.11.4',
  name: 'Havemind',
  version: '0.0.1',
};

const MAGDA: RosterMember = {
  membershipId: 'm-magda',
  displayName: 'Magda',
  role: 'editor',
  self: false,
};

const ENTRY: ActivityLogEntry = {
  revisionId: 'rev-1',
  fileId: 'file-1',
  path: 'Notes/One.md',
  kind: 'edit',
  author: { kind: 'member', membershipId: 'm-magda' },
  timestamp: 1_700_000_000_000,
  hasContent: true,
};

/** A plugin whose plugin-data lives in memory, so the flag can persist. */
function newPlugin(): {
  plugin: HavemindPlugin;
  disk: () => Record<string, unknown>;
} {
  const plugin = new HavemindPlugin(new App(), manifest);
  let disk: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).loadData = async () => disk;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).saveData = async (data: unknown) => {
    disk = data as Record<string, unknown>;
  };
  return { plugin, disk: () => disk };
}

function command(id: string): Command {
  const found = registrationState.commands.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`command "${id}" was not registered`);
  return found;
}

/** Seeds the live feed and roster the overlay reads its attribution from. */
function seedFeed(plugin: HavemindPlugin): void {
  (plugin as unknown as { activityLog: ActivityLog }).activityLog.record(ENTRY);
  (plugin as unknown as { rosterMembers: RosterMember[] }).rosterMembers = [
    MAGDA,
  ];
}

/** Renders one Reading-view block through every registered post processor. */
function renderBlock(
  section: ReadingViewSectionInfo | null,
  sourcePath = 'Notes/One.md',
): MockElement {
  const element = createMockElement();
  for (const processor of registrationState.markdownPostProcessors) {
    processor(element as unknown as HTMLElement, {
      sourcePath,
      getSectionInfo: () => section,
    });
  }
  return element;
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('author overlay wiring (FINDING 1)', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('registers the Live Preview extension and the Reading-view processor once', async () => {
    const { plugin } = newPlugin();
    await plugin.onload();

    expect(registrationState.editorExtensions).toHaveLength(1);
    expect(registrationState.markdownPostProcessors).toHaveLength(1);
  });

  it('keeps Show authors on the command palette after losing its ribbon icon', async () => {
    // plans/007 Stage 0 collapsed the ribbon to one hexagon; the overlay toggle
    // moved into the pane. The command is what keeps it reachable without a
    // mouse, so dropping the icon must not drop the keyboard route (F8-02d).
    const { plugin } = newPlugin();
    await plugin.onload();

    expect(command('show-authors').name).toBe('Show authors');
    expect(
      registrationState.ribbons.some((r) => r.iconName === 'users'),
    ).toBe(false);
  });

  it('starts with the overlay off and flips it from the command', async () => {
    const { plugin } = newPlugin();
    await plugin.onload();

    expect(plugin.authorOverlayEnabled()).toBe(false);

    command('show-authors').callback?.();
    expect(plugin.authorOverlayEnabled()).toBe(true);

    command('show-authors').callback?.();
    expect(plugin.authorOverlayEnabled()).toBe(false);
  });

  it('flips the same flag however it is invoked', async () => {
    // The overlay used to be toggled from a ribbon icon as well as the command.
    // The icon is gone (plans/007 Stage 0); the flag it flipped must behave
    // identically from the surviving route.
    const { plugin } = newPlugin();
    await plugin.onload();

    command('show-authors').callback?.();
    expect(plugin.authorOverlayEnabled()).toBe(true);

    command('show-authors').callback?.();
    expect(plugin.authorOverlayEnabled()).toBe(false);
  });

  it('tells the user which way the overlay just went', async () => {
    const { plugin } = newPlugin();
    await plugin.onload();

    command('show-authors').callback?.();

    expect(
      registrationState.notices.some((message) =>
        message.startsWith('Havemind: author overlay on'),
      ),
    ).toBe(true);
  });

  it('persists the flag to data.json and restores it on the next load', async () => {
    const { plugin, disk } = newPlugin();
    await plugin.onload();

    command('show-authors').callback?.();
    await flush();
    expect(disk()['showAuthors']).toBe(true);

    // A second plugin over the same data.json comes up with the overlay on.
    const restored = new HavemindPlugin(new App(), manifest);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (restored as any).loadData = async () => disk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (restored as any).saveData = async () => undefined;
    await restored.onload();
    await flush();
    expect(restored.authorOverlayEnabled()).toBe(true);
  });

  it('survives a data.json that cannot be read, staying session-only', async () => {
    const plugin = new HavemindPlugin(new App(), manifest);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any).loadData = async () => {
      throw new Error('data.json is unreadable');
    };
    await plugin.onload();
    await flush();

    expect(plugin.authorOverlayEnabled()).toBe(false);
  });

  it('marks a rendered Reading-view block from the live Activity feed', async () => {
    const { plugin } = newPlugin();
    await plugin.onload();
    seedFeed(plugin);
    command('show-authors').callback?.();

    const element = renderBlock({
      text: 'Hello world\n',
      lineStart: 0,
      lineEnd: 0,
    });

    expect(element.classes).toContain(AUTHOR_BLOCK_CLASS);
    expect(element.attrs['data-havemind-authors']).toBe('Magda');
    expect(element.attrs['title']).toContain('Magda');
  });

  it('leaves the block untouched while the overlay is off', async () => {
    const { plugin } = newPlugin();
    await plugin.onload();
    seedFeed(plugin);

    const element = renderBlock({
      text: 'Hello world\n',
      lineStart: 0,
      lineEnd: 0,
    });

    expect(element.classes).not.toContain(AUTHOR_BLOCK_CLASS);
  });

  it('leaves a block untouched when nothing is recorded for its file', async () => {
    const { plugin } = newPlugin();
    await plugin.onload();
    seedFeed(plugin);
    command('show-authors').callback?.();

    const element = renderBlock(
      { text: 'Hello world\n', lineStart: 0, lineEnd: 0 },
      'Notes/Never-synced.md',
    );

    expect(element.classes).not.toContain(AUTHOR_BLOCK_CLASS);
  });

  it('leaves a block untouched when its section did not resolve', async () => {
    const { plugin } = newPlugin();
    await plugin.onload();
    seedFeed(plugin);
    command('show-authors').callback?.();

    expect(renderBlock(null).classes).not.toContain(AUTHOR_BLOCK_CLASS);
  });
});

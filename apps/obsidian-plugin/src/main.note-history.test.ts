/**
 * "Show history of this note" (plan 012, step 4): offered for a synced note
 * while a connection is live, and it opens the history window on that note.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin from './main';
import { App, Menu, registrationState, resetObsidianMock, type MockElement } from './test/obsidian.mock';
import { flatten } from './test/dom';
import { manifest } from './test/fixtures';
import { internals } from './test/plugin-internals';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const command = (id: string) => registrationState.commands.find((entry) => entry.id === id);

let fileMenu: ((menu: unknown, file: unknown) => void) | undefined;

function connectedPlugin(): HavemindPlugin {
  const app = new App();
  (app.workspace as unknown as { on: (name: string, cb: (m: unknown, f: unknown) => void) => unknown }).on = (name, cb) => {
    if (name === 'file-menu') fileMenu = cb;
    return { name };
  };
  (app.workspace as unknown as { getActiveFile: () => unknown }).getActiveFile = () => ({
    path: 'Venue.md',
    basename: 'Venue',
    extension: 'md',
  });
  (app.vault as unknown as { read: () => Promise<string> }).read = async () => 'one\nthree\n';
  const plugin = new HavemindPlugin(app, manifest);
  internals(plugin).loadData = async () => null;
  internals(plugin).saveData = async () => undefined;
  plugin.onload();
  (plugin as unknown as { connection: unknown }).connection = {
    serverName: 'server.example',
    stop: () => undefined,
    noteEvents: async () => [
      { serverSequence: 3, revision: { revisionId: 'b', fileId: 'f1', contentHash: 'h', authorMembershipId: 'm2', acceptedAt: '2026-10-14T16:05:00.000Z' } },
    ],
    revisionContent: async () => ({ fileId: 'f1', path: 'Venue.md', content: 'one\ntwo\n' }),
  };
  (plugin as unknown as { syncState: unknown }).syncState = {
    fileIdAtPath: (path: string) => (path === 'Venue.md' ? 'f1' : null),
  };
  plugin.people.rosterMembers = [{ membershipId: 'm2', displayName: 'Hubert', role: 'editor', self: false }];
  return plugin;
}

describe('Show history of this note', () => {
  beforeEach(() => resetObsidianMock());

  it('is offered only for a synced note while connected', () => {
    const plugin = connectedPlugin();
    expect(command('note-history')?.checkCallback?.(true)).toBe(true);
    (plugin as unknown as { connection: unknown }).connection = null;
    expect(command('note-history')?.checkCallback?.(true)).toBe(false);
  });

  it('opens the history window listing who changed the note', async () => {
    connectedPlugin();
    command('note-history')?.checkCallback?.(false);
    await settle();
    const modal = registrationState.modals.at(-1) as unknown as { contentEl: MockElement } | undefined;
    const texts = modal === undefined ? [] : flatten(modal.contentEl).map((el) => el.text);
    expect(texts).toContain('History of Venue');
    expect(texts.some((t) => t.startsWith('Hubert · '))).toBe(true);
  });

  it('offers the same in the file menu of a synced note, and not of an unsynced one', () => {
    connectedPlugin();
    const synced = new Menu();
    fileMenu?.(synced, { path: 'Venue.md', basename: 'Venue', extension: 'md' });
    expect(synced.items.map((item) => item.title)).toEqual(['Show history of this note']);
    const other = new Menu();
    fileMenu?.(other, { path: 'Other.md', basename: 'Other', extension: 'md' });
    expect(other.items).toEqual([]);
  });
});

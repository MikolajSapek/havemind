/** "Show history of this note" (plan 012): the command and the file menu item. */

import type { EventRef } from 'obsidian';

import type HavemindPlugin from '../main';
import { buildNoteHistory } from '../runtime/note-history';
import { NoteHistoryModal } from '../ui/note-history-modal';

type Host = Pick<HavemindPlugin, 'app' | 'connection' | 'syncState' | 'people' | 'handleRestore'>;

interface NoteFile {
  readonly path: string;
  readonly basename?: string;
  readonly extension?: string;
}

/** The note and its file id when its history can be shown, else null. */
function target(plugin: Host, file: NoteFile | null | undefined): { note: NoteFile; fileId: string } | null {
  if (file === null || file === undefined || file.extension !== 'md') return null;
  const connection = plugin.connection;
  if (connection?.noteEvents === undefined || connection.revisionContent === undefined) return null;
  const fileId = plugin.syncState?.fileIdAtPath(file.path) ?? null;
  return fileId === null ? null : { note: file, fileId };
}

function activeNote(plugin: Host): NoteFile | null {
  const workspace = plugin.app.workspace as { getActiveFile?: () => NoteFile | null };
  return workspace.getActiveFile?.() ?? null;
}

async function open(plugin: Host, note: NoteFile, fileId: string): Promise<void> {
  const connection = plugin.connection;
  if (connection?.noteEvents === undefined || connection.revisionContent === undefined) return;
  const loadVersion = connection.revisionContent;
  const events = await connection.noteEvents(fileId);
  const vault = plugin.app as unknown as { vault: { read: (file: NoteFile) => Promise<string> } };
  new NoteHistoryModal(plugin.app, {
    title: note.basename ?? note.path,
    rows: buildNoteHistory(events, plugin.people.rosterMembers),
    loadVersion,
    currentText: () => vault.vault.read(note),
    onRestore: (revisionId) => {
      void plugin.handleRestore(revisionId);
    },
  }).open();
}

export function registerNoteHistory(plugin: HavemindPlugin): void {
  plugin.addCommand({
    id: 'note-history',
    name: 'Show history of this note',
    checkCallback: (checking) => {
      const found = target(plugin, activeNote(plugin));
      if (found === null) return false;
      if (!checking) void open(plugin, found.note, found.fileId);
      return true;
    },
  });
  const workspace = plugin.app.workspace as {
    on: (name: string, callback: (menu: unknown, file: NoteFile) => void) => unknown;
  };
  const ref = workspace.on('file-menu', (menu, file) => {
    const found = target(plugin, file);
    if (found === null) return;
    (menu as { addItem: (build: (item: MenuItemLike) => void) => void }).addItem((item) => {
      item
        .setTitle('Show history of this note')
        .setIcon('history')
        .onClick(() => {
          void open(plugin, found.note, found.fileId);
        });
    });
  });
  if (ref !== undefined && ref !== null) plugin.registerEvent(ref as EventRef);
}

interface MenuItemLike {
  setTitle(title: string): MenuItemLike;
  setIcon(icon: string): MenuItemLike;
  onClick(callback: () => void): MenuItemLike;
}

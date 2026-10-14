/**
 * "History of this note" (plan 012): every accepted version, who made it and
 * when; a picked version shows how it differs from the note now, and Restore
 * writes it back as a normal edit. The diff runs here, on the client (rule 2).
 */

import { Modal, type App } from 'obsidian';

import type { RevisionContent } from '../runtime/activity-restore';
import { computeLineDiff } from '../runtime/conflict-resolution';

import { renderDiff } from './diff-view';
import type { NoteHistoryRow } from '../runtime/note-history';

import { armedButton, renderViewTitle } from './primitives';

export interface NoteHistoryDeps {
  readonly title: string;
  readonly rows: readonly NoteHistoryRow[];
  /** A version's text, or null for a deletion or an attachment. */
  readonly loadVersion: (revisionId: string) => Promise<RevisionContent | null>;
  readonly currentText: () => Promise<string>;
  readonly onRestore: (revisionId: string) => void;
}

export function renderNoteHistory(container: HTMLElement, deps: NoteHistoryDeps): void {
  container.addClass('havemind-history');
  renderViewTitle(container, `History of ${deps.title}`);
  if (deps.rows.length === 0) {
    container.createDiv({ text: 'No synced versions of this note yet.' }).addClass('havemind-hint');
    return;
  }
  container
    .createDiv({ text: 'Times are when each version reached the server.' })
    .addClass('havemind-hint');
  const list = container.createDiv();
  list.addClass('havemind-history-list');
  const detail = container.createDiv();
  detail.addClass('havemind-history-detail');
  detail
    .createDiv({ text: 'Pick a version to see how it differs from the note now.' })
    .addClass('havemind-hint');
  // Only the latest pick may draw: an earlier one that loads later is dropped.
  let latest = 0;
  const items: HTMLElement[] = [];
  for (const row of deps.rows) {
    const item = list.createEl('button', { text: `${row.author} · ${row.when}` });
    item.addClass('havemind-history-row');
    items.push(item);
    item.onClickEvent(() => {
      for (const other of items) other.removeClass('is-active');
      item.addClass('is-active');
      latest += 1;
      const pick = latest;
      void showVersion(detail, row.revisionId, deps, () => pick === latest);
    });
  }
}

async function showVersion(
  detail: HTMLElement,
  revisionId: string,
  deps: NoteHistoryDeps,
  stillWanted: () => boolean,
): Promise<void> {
  let version: RevisionContent | null;
  let now: string;
  try {
    [version, now] = await Promise.all([deps.loadVersion(revisionId), deps.currentText()]);
  } catch (error) {
    if (!stillWanted()) return;
    detail.empty();
    console.warn('Havemind: could not load a version for the note history', error);
    detail
      .createDiv({ text: 'Could not load this version. Check the connection and try again.' })
      .addClass('havemind-hint');
    return;
  }
  if (!stillWanted()) return;
  detail.empty();
  if (version === null) {
    detail
      .createDiv({ text: 'This version has no text to show: it is a deletion or an attachment.' })
      .addClass('havemind-hint');
    return;
  }
  if (version.content === now) {
    detail
      .createDiv({ text: 'This version is the same as the note now.' })
      .addClass('havemind-hint');
    return;
  }
  // Restore first: the diff below can be long, the action should not be.
  armedButton(detail, 'Restore this version', 'Confirm restore', 'havemind-history-restore', () =>
    deps.onRestore(revisionId),
  );
  const diff = computeLineDiff(now, version.content);
  if (diff === null) {
    detail
      .createDiv({ text: 'The difference is too large to show here.' })
      .addClass('havemind-hint');
    return;
  }
  detail.createDiv({ text: '− now · + this version' }).addClass('havemind-conflict-legend');
  renderDiff(detail, diff);
}

export class NoteHistoryModal extends Modal {
  constructor(
    app: App,
    private readonly deps: NoteHistoryDeps,
  ) {
    super(app);
  }

  override onOpen(): void {
    renderNoteHistory(this.contentEl, {
      ...this.deps,
      onRestore: (revisionId) => {
        this.deps.onRestore(revisionId);
        this.close();
      },
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

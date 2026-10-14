/**
 * "History of this note" (plan 012): every accepted version, who made it and
 * when; a picked version shows how it differs from the note now, and Restore
 * writes it back as a normal edit. The diff runs here, on the client (rule 2).
 */

import { Modal, type App } from 'obsidian';

import type { RevisionContent } from '../runtime/activity-restore';
import { computeLineDiff } from '../runtime/conflict-resolution';
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
  const list = container.createDiv();
  list.addClass('havemind-history-list');
  const detail = container.createDiv();
  detail.addClass('havemind-history-detail');
  for (const row of deps.rows) {
    const item = list.createEl('button', { text: `${row.author} · ${row.when}` });
    item.addClass('havemind-history-row');
    item.onClickEvent(() => {
      void showVersion(detail, row.revisionId, deps);
    });
  }
}

async function showVersion(detail: HTMLElement, revisionId: string, deps: NoteHistoryDeps): Promise<void> {
  detail.empty();
  const [version, now] = await Promise.all([deps.loadVersion(revisionId), deps.currentText()]);
  if (version === null) {
    detail
      .createDiv({ text: 'This version has no text to show: it is a deletion or an attachment.' })
      .addClass('havemind-hint');
    return;
  }
  const diff = computeLineDiff(now, version.content);
  if (diff === null) {
    detail
      .createDiv({ text: 'The difference is too large to show here.' })
      .addClass('havemind-hint');
  } else {
    detail.createDiv({ text: '− now · + this version' }).addClass('havemind-conflict-legend');
    const box = detail.createDiv();
    box.addClass('havemind-conflict-diff');
    for (const line of diff) {
      const prefix = line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  ';
      const row = box.createDiv({ text: `${prefix}${line.text}` });
      row.addClass('havemind-conflict-line');
      row.addClass(`havemind-conflict-line-${line.type}`);
    }
  }
  armedButton(detail, 'Restore this version', 'Confirm restore', 'havemind-history-restore', () =>
    deps.onRestore(revisionId),
  );
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

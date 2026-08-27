/**
 * The MRG-03 "Conflicts" panel section: a header with a count badge and one row
 * per conflict copy found in the vault, each offering a Resolve button that opens
 * the diff modal. Kept separate from the modal it opens (`ui/conflict-modal.ts`)
 * because this section is a read-only list drawn inside the onboarding panel,
 * while the modal owns the destructive resolution choices. Presentation only,
 * the vault scan happens in the caller's provider.
 */

import { setIcon } from 'obsidian';

import type { ConflictCopy } from '../runtime/conflict-resolution';

import { DECORATIVE, renderAlarmBlock } from './primitives';

/** Actions attached to each conflict-copy row in the panel section. */
export interface ConflictSectionActions {
  /** Open the resolve modal for the copy at this vault path. */
  readonly onResolve: (copyPath: string) => void;
}

/**
 * Renders the "Conflicts" panel section: a header (git-merge icon + count
 * badge) and one row per conflict copy. The section is drawn only when copies
 * exist, so the caller must skip it for an empty list. Each row shows the target
 * note, author and timestamp, or the manual-resolution hint when the target is
 * unknown, plus a Resolve button opening the diff modal.
 */
export function renderConflictSection(
  content: HTMLElement,
  copies: readonly ConflictCopy[],
  actions: ConflictSectionActions,
): void {
  if (copies.length === 0) return;

  // One block around the heading and every row: the border, the tint and the
  // left rule belong to the alarm as a whole, and drawn as siblings they each
  // enclosed only a fragment of it.
  const block = renderAlarmBlock(content, 'havemind-alarm-conflict');

  const header = block.createDiv({ text: '' });
  header.addClass('havemind-conflict-header');
  const icon = header.createEl('span', { attr: DECORATIVE });
  icon.addClass('havemind-conflict-icon');
  setIcon(icon, 'git-merge');
  // The design states the count in the heading, "2 conflicts", rather than
  // parking a bare numeral at the far edge, where it read as a badge for
  // something else on the row.
  header.createEl('span', {
    text: copies.length === 1 ? ' 1 conflict' : ` ${copies.length} conflicts`,
  });

  const rows = block.createDiv();
  rows.addClass('havemind-alarm-rows');

  for (const copy of copies) {
    const row = rows.createDiv({ text: '' });
    row.addClass('havemind-conflict-row');

    const name = copy.noteName ?? copy.copyName;
    row.createEl('span', { text: name }).addClass('havemind-conflict-note');
    if (copy.author !== null && copy.timestamp !== null) {
      row.createEl('span', {
        text: ` · ${copy.author} · ${copy.timestamp}`,
      }).addClass('havemind-conflict-meta');
    }
    if (copy.manualHint !== null) {
      const hint = row.createDiv({ text: copy.manualHint });
      hint.addClass('havemind-conflict-hint');
    }

    const resolve = row.createEl('button', { text: 'Resolve' });
    resolve.addClass('mod-cta');
    resolve.addClass('havemind-conflict-action');
    resolve.onClickEvent(() => actions.onResolve(copy.copyPath));
  }
}

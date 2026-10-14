/** The line diff as both the conflict and the history window draw it. */

import type { DiffLine } from '../runtime/conflict-resolution';
import { collapseUnchanged } from '../runtime/diff-collapse';

export function renderDiff(container: HTMLElement, diff: readonly DiffLine[]): void {
  const box = container.createDiv();
  box.addClass('havemind-conflict-diff');
  for (const row of collapseUnchanged(diff)) {
    if (row.type === 'gap') {
      box
        .createDiv({ text: `… ${row.count} unchanged lines` })
        .addClass('havemind-conflict-gap');
      continue;
    }
    const prefix = row.type === 'added' ? '+ ' : row.type === 'removed' ? '- ' : '  ';
    const line = box.createDiv({ text: `${prefix}${row.text}` });
    line.addClass('havemind-conflict-line');
    line.addClass(`havemind-conflict-line-${row.type}`);
  }
}

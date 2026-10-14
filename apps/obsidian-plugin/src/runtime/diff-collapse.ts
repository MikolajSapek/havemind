/**
 * Folds the unchanged stretches of a line diff (1.8.1). A long note with one
 * changed line used to show every line, so the change had to be found by
 * scrolling the whole note; now each change keeps three lines around it.
 */

import type { DiffLine } from './conflict-resolution';

export type DiffRow = DiffLine | { readonly type: 'gap'; readonly count: number };

const CONTEXT = 3;

export function collapseUnchanged(diff: readonly DiffLine[], context: number = CONTEXT): DiffRow[] {
  const keep = diff.map(() => false);
  diff.forEach((line, index) => {
    if (line.type === 'context') return;
    for (let k = Math.max(0, index - context); k <= Math.min(diff.length - 1, index + context); k += 1) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < diff.length) {
    if (keep[index]) {
      rows.push(diff[index] as DiffLine);
      index += 1;
      continue;
    }
    let end = index;
    while (end < diff.length && !keep[end]) end += 1;
    // Folding one line into a "1 unchanged line" row saves nothing.
    if (end - index > 1) rows.push({ type: 'gap', count: end - index });
    else rows.push(diff[index] as DiffLine);
    index = end;
  }
  return rows;
}

import { describe, expect, it } from 'vitest';

import type { DiffLine } from './conflict-resolution';
import { collapseUnchanged } from './diff-collapse';

const ctx = (n: number): DiffLine[] => Array.from({ length: n }, (_, i) => ({ type: 'context' as const, text: `c${i}` }));

describe('collapseUnchanged (1.8.1)', () => {
  it('keeps three lines around each change and folds the rest into a count', () => {
    const diff: DiffLine[] = [...ctx(20), { type: 'removed', text: 'old' }, { type: 'added', text: 'new' }, ...ctx(20)];
    const rows = collapseUnchanged(diff);
    expect(rows[0]).toEqual({ type: 'gap', count: 17 });
    expect(rows.slice(1, 4).map((r) => ('text' in r ? r.text : ''))).toEqual(['c17', 'c18', 'c19']);
    expect(rows.slice(4, 6).map((r) => r.type)).toEqual(['removed', 'added']);
    expect(rows.at(-1)).toEqual({ type: 'gap', count: 17 });
    expect(rows).toHaveLength(1 + 3 + 2 + 3 + 1);
  });

  it('never folds a run shorter than what the fold replaces', () => {
    const diff: DiffLine[] = [{ type: 'added', text: 'a' }, ...ctx(7), { type: 'added', text: 'b' }];
    expect(collapseUnchanged(diff).some((r) => r.type === 'gap')).toBe(false);
  });

  it('folds a diff with no changes into one gap', () => {
    expect(collapseUnchanged(ctx(50))).toEqual([{ type: 'gap', count: 50 }]);
  });
});

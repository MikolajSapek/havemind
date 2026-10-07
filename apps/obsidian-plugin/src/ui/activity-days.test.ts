import { describe, expect, it } from 'vitest';

import type { RevisionRecord } from '../activity/activity';
import { asEl, createContent, flatten } from '../test/dom';

import { renderActivityRows } from './activity-section';

const DAY = 86_400_000;

function record(revisionId: string, timestamp: number, overrides: Partial<RevisionRecord> = {}): RevisionRecord {
  return {
    revisionId,
    fileId: `f-${revisionId}`,
    path: 'Reunion/Venue.md',
    kind: 'edit',
    actor: { kind: 'author', actorId: 'u1', displayName: 'Hubert' },
    timestamp,
    content: 'x',
    ...overrides,
  };
}

describe('Activity rows (plan 010)', () => {
  it('groups rows under day headers, newest first, with a clock time', () => {
    const now = new Date(2026, 9, 7, 12, 0).getTime();
    const content = createContent();
    renderActivityRows(asEl(content), {
      feed: [record('a', now - 60_000), record('b', now - DAY), record('c', now - 2 * 60_000)],
      now,
    });
    const texts = flatten(content)
      .filter((el) => el.classes.includes('havemind-activity-day') || el.classes.includes('havemind-activity-title'))
      .map((el) => el.text);
    expect(texts).toEqual(['Today', 'Venue', 'Venue', 'Yesterday', 'Venue']);
    expect(flatten(content).find((el) => el.classes.includes('havemind-activity-time'))?.text).toBe('11:59');
  });

  it('marks a deletion and a conflict in the row, not with a colour bar', () => {
    const now = Date.now();
    const content = createContent();
    renderActivityRows(asEl(content), {
      feed: [
        record('d', now - 1_000, { kind: 'delete', content: null }),
        record('e', now - 2_000, { kind: 'conflict' }),
      ],
    });
    const rows = flatten(content).filter((el) => el.classes.includes('havemind-activity-row'));
    expect(rows[0]?.classes).toContain('is-delete');
    expect(rows[1]?.classes).toContain('is-conflict');
    expect(rows.every((row) => row.styleProperties['--havemind-row-color'] === undefined)).toBe(true);
  });
});

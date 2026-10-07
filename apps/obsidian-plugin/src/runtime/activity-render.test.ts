import { describe, expect, it } from 'vitest';

import {
  activityDayLabel,
  buildActivityViewModel,
  clockLabel,
} from './activity-render';
import {
  authorColorToken,
  INITIAL_IMPORT_COLOR_TOKEN,
} from './author-colors';
import type { RevisionRecord } from '../activity/activity';

function record(overrides: Partial<RevisionRecord> = {}): RevisionRecord {
  return {
    revisionId: 'rev-1',
    fileId: 'file-1',
    path: 'Notes/a.md',
    kind: 'edit',
    actor: { kind: 'author', actorId: 'u1', displayName: 'Alice' },
    timestamp: 100,
    content: 'A\n',
    ...overrides,
  };
}

describe('buildActivityViewModel', () => {
  it('renders newest-first rows with a human label and restore flag', () => {
    const model = buildActivityViewModel([
      record({ revisionId: 'rev-old', timestamp: 10 }),
      record({ revisionId: 'rev-new', timestamp: 20, path: 'Notes/b.md' }),
    ]);
    expect(model.empty).toBe(false);
    expect(model.rows.map((row) => row.revisionId)).toEqual([
      'rev-new',
      'rev-old',
    ]);
    expect(model.rows[0]?.label).toBe('edit · Notes/b.md · Alice');
    // Two-line presentation: `author verb` headline over the vault path.
    expect(model.rows[0]?.headline).toBe('Alice edited');
    expect(model.rows[0]?.pathLabel).toBe('Notes/b.md');
    expect(model.rows[0]?.canRestore).toBe(true);
  });

  it('pairs each row with the author colour token and a time label', () => {
    const model = buildActivityViewModel(
      [record({ actor: { kind: 'author', actorId: 'u1', displayName: 'Alice' }, timestamp: 1000 })],
      { formatTimestamp: (ts) => `@${ts}` },
    );
    // Colour is the stable per-author token, same source as roster/overlay.
    expect(model.rows[0]?.colorToken).toBe(authorColorToken('u1'));
    // Author name lives in the label, so colour is never the only signal.
    expect(model.rows[0]?.label).toContain('Alice');
    expect(model.rows[0]?.timeLabel).toBe('@1000');
  });

  it('uses the neutral import token for an initial-import fragment', () => {
    const model = buildActivityViewModel([
      record({ actor: { kind: 'initial-import' } }),
    ]);
    expect(model.rows[0]?.colorToken).toBe(INITIAL_IMPORT_COLOR_TOKEN);
  });

  it('labels an initial-import fragment without inventing an author', () => {
    const model = buildActivityViewModel([
      record({ actor: { kind: 'initial-import' } }),
    ]);
    expect(model.rows[0]?.label).toBe('edit · Notes/a.md · Initial import');
  });

  it('marks a deletion as not restorable and reports an empty feed', () => {
    const model = buildActivityViewModel([
      record({ kind: 'delete', content: null }),
    ]);
    expect(model.rows[0]?.canRestore).toBe(false);
    expect(buildActivityViewModel([]).empty).toBe(true);
  });
});

describe('minimal rows (plan 010)', () => {
  it('leads with the note name and says who did what in the past tense', () => {
    const rows = buildActivityViewModel([
      record({ revisionId: 'a', path: 'Reunion/Venue.md', kind: 'edit', timestamp: 5 }),
      record({ revisionId: 'b', path: 'pliki/plan.pdf', kind: 'create', timestamp: 4 }),
      record({ revisionId: 'c', path: 'Oferty.md', kind: 'rename', timestamp: 3 }),
      record({ revisionId: 'd', path: 'old.md', kind: 'delete', content: null, timestamp: 2 }),
      record({ revisionId: 'e', path: 'Venue.md', kind: 'conflict', timestamp: 1 }),
    ]).rows;
    expect(rows.map((row) => [row.title, row.meta])).toEqual([
      ['Venue', 'Alice edited'],
      ['plan.pdf', 'Alice created it'],
      ['Oferty', 'Alice renamed it'],
      ['old', 'Alice deleted it'],
      ['Venue', 'Both versions kept'],
    ]);
  });

  it('names the initial import without inventing an author', () => {
    const rows = buildActivityViewModel([record({ actor: { kind: 'initial-import' } })]).rows;
    expect(rows[0]?.meta).toBe('Initial import');
  });

  it('labels days the way a person reads them', () => {
    const now = new Date(2026, 9, 7, 9, 30).getTime();
    expect(activityDayLabel(new Date(2026, 9, 7, 0, 5).getTime(), now)).toBe('Today');
    expect(activityDayLabel(new Date(2026, 9, 6, 23, 59).getTime(), now)).toBe('Yesterday');
    expect(activityDayLabel(new Date(2026, 9, 3, 12, 0).getTime(), now)).toBe('3 Oct');
    expect(clockLabel(new Date(2026, 9, 7, 6, 2).getTime())).toBe('06:02');
  });
});

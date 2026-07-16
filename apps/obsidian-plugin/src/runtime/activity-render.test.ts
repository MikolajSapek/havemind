import { describe, expect, it } from 'vitest';

import {
  buildActivityViewModel,
  formatDiffRows,
} from './activity-render';
import type { RevisionRecord } from '../activity/activity';

function record(overrides: Partial<RevisionRecord> = {}): RevisionRecord {
  return {
    revisionId: 'rev-1',
    vaultId: 'vault-1',
    fileId: 'file-1',
    path: 'Notes/a.md',
    previousPath: null,
    kind: 'edit',
    actor: { kind: 'author', actorId: 'u1', displayName: 'Alice' },
    timestamp: 100,
    content: 'A\n',
    blobHash: 'h1',
    parentRevisionIds: [],
    provenance: [],
    restoredFromRevisionId: null,
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
    expect(model.rows[0]?.canRestore).toBe(true);
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

describe('formatDiffRows', () => {
  it('renders unified line prefixes for the diff modal', () => {
    expect(formatDiffRows('A\nB\n', 'A\nC\n')).toEqual([
      '  A',
      '- B',
      '+ C',
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import { createInitialProvenance } from '@havemind/sync-core';

import type { RevisionRecord } from '../activity/activity';
import { restoreActivityEntry } from './activity-restore';

function record(overrides: Partial<RevisionRecord> = {}): RevisionRecord {
  const revisionId = overrides.revisionId ?? 'rev-1';
  const content = overrides.content === undefined ? 'A\n' : overrides.content;
  return {
    revisionId,
    vaultId: 'vault-1',
    fileId: 'file-1',
    path: 'Notes/a.md',
    previousPath: null,
    kind: 'edit',
    actor: { kind: 'author', actorId: 'u1', displayName: 'Alice' },
    timestamp: 100,
    content,
    blobHash: 'h1',
    parentRevisionIds: [],
    // A record used as a restore parent must carry provenance that fully
    // covers its own content (sync-core's assertValidProvenance).
    provenance: content === null ? [] : createInitialProvenance(content, revisionId),
    restoredFromRevisionId: null,
    ...overrides,
  };
}

describe('restoreActivityEntry', () => {
  it('appends a new entry attributed to the restorer for a valid target', () => {
    const entry = restoreActivityEntry({
      history: [record({ revisionId: 'rev-1' })],
      targetRevisionId: 'rev-1',
      restorer: { actorId: 'm-owner', displayName: 'You' },
      now: 500,
      newRevisionId: 'rev-2',
    });

    expect(entry).toEqual({
      revisionId: 'rev-2',
      fileId: 'file-1',
      path: 'Notes/a.md',
      kind: 'edit',
      author: { kind: 'member', membershipId: 'm-owner' },
      timestamp: 500,
      hasContent: true,
    });
  });

  it('returns null for an unknown target revision instead of throwing', () => {
    const entry = restoreActivityEntry({
      history: [record({ revisionId: 'rev-1' })],
      targetRevisionId: 'rev-does-not-exist',
      restorer: { actorId: 'm-owner', displayName: 'You' },
      now: 500,
      newRevisionId: 'rev-2',
    });

    expect(entry).toBeNull();
  });

  it('returns null for a deleted target (nothing to restore)', () => {
    const entry = restoreActivityEntry({
      history: [record({ revisionId: 'rev-1', kind: 'delete', content: null })],
      targetRevisionId: 'rev-1',
      restorer: { actorId: 'm-owner', displayName: 'You' },
      now: 500,
      newRevisionId: 'rev-2',
    });

    expect(entry).toBeNull();
  });

  it('returns null when history has no single reconciled head', () => {
    // A genuine fork: rev-1 is the root, rev-2 and rev-3 both branch off it
    // (same parentRevisionIds), so the DAG has two heads for this file.
    const entry = restoreActivityEntry({
      history: [
        record({ revisionId: 'rev-1' }),
        record({ revisionId: 'rev-2', parentRevisionIds: ['rev-1'], timestamp: 200 }),
        record({ revisionId: 'rev-3', parentRevisionIds: ['rev-1'], timestamp: 300 }),
      ],
      targetRevisionId: 'rev-1',
      restorer: { actorId: 'm-owner', displayName: 'You' },
      now: 500,
      newRevisionId: 'rev-4',
    });

    expect(entry).toBeNull();
  });
});

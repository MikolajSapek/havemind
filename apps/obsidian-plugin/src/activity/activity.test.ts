import { describe, expect, it } from 'vitest';

import { createInitialProvenance } from '@havemind/sync-core';

import { buildActivityFeed, type RevisionRecord } from './activity';

const VAULT = 'vault-1';
const FILE = 'file-1';

function record(overrides: Partial<RevisionRecord> & { revisionId: string }): RevisionRecord {
  const content = overrides.content === undefined ? 'body\n' : overrides.content;
  return {
    actor: { kind: 'initial-import' },
    blobHash: `hash-${overrides.revisionId}`,
    content,
    fileId: FILE,
    kind: 'create',
    parentRevisionIds: [],
    path: 'Note.md',
    previousPath: null,
    provenance:
      content === null
        ? []
        : createInitialProvenance(content, overrides.revisionId),
    restoredFromRevisionId: null,
    timestamp: 1,
    vaultId: VAULT,
    ...overrides,
  };
}

describe('buildActivityFeed', () => {
  it('orders entries newest first and labels the initial import without a false author', () => {
    const feed = buildActivityFeed([
      record({ revisionId: 'r1', timestamp: 10 }),
      record({
        revisionId: 'r2',
        timestamp: 30,
        kind: 'edit',
        content: 'body edited\n',
        actor: { kind: 'author', actorId: 'a-bob', displayName: 'Bob' },
        parentRevisionIds: ['r1'],
      }),
      record({
        revisionId: 'r3',
        timestamp: 20,
        kind: 'conflict',
        actor: { kind: 'author', actorId: 'a-ana', displayName: 'Ana' },
        parentRevisionIds: ['r1'],
      }),
    ]);

    expect(feed.map((entry) => entry.revisionId)).toEqual(['r2', 'r3', 'r1']);
    expect(feed.map((entry) => entry.actorLabel)).toEqual([
      'Bob',
      'Ana',
      'Initial import',
    ]);
    expect(feed[2]?.kind).toBe('create');
  });

  it('breaks ties on revision id and marks deletions as not restorable', () => {
    const feed = buildActivityFeed([
      record({ revisionId: 'rb', timestamp: 5 }),
      record({ revisionId: 'ra', timestamp: 5 }),
      record({
        revisionId: 'rd',
        timestamp: 8,
        kind: 'delete',
        content: null,
        parentRevisionIds: ['ra'],
      }),
    ]);

    expect(feed.map((entry) => entry.revisionId)).toEqual(['rd', 'rb', 'ra']);
    expect(feed[0]?.canRestore).toBe(false);
    expect(feed[1]?.canRestore).toBe(true);
  });
});

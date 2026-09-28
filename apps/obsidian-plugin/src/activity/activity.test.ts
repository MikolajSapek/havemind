import { describe, expect, it } from 'vitest';

import { buildActivityFeed, type RevisionRecord } from './activity';

const FILE = 'file-1';

function record(overrides: Partial<RevisionRecord> & { revisionId: string }): RevisionRecord {
  const content = overrides.content === undefined ? 'body\n' : overrides.content;
  return {
    actor: { kind: 'initial-import' },
    content,
    fileId: FILE,
    kind: 'create',
    path: 'Note.md',
    timestamp: 1,
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
      }),
      record({
        revisionId: 'r3',
        timestamp: 20,
        kind: 'conflict',
        actor: { kind: 'author', actorId: 'a-ana', displayName: 'Ana' },
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
      }),
    ]);

    expect(feed.map((entry) => entry.revisionId)).toEqual(['rd', 'rb', 'ra']);
    expect(feed[0]?.canRestore).toBe(false);
    expect(feed[1]?.canRestore).toBe(true);
  });
});

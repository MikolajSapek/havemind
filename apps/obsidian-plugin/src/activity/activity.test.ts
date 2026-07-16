import { describe, expect, it } from 'vitest';

import { createInitialProvenance, RevisionDag } from '@havemind/sync-core';

import {
  ActivityError,
  buildActivityFeed,
  computeRevisionDiff,
  restoreRevision,
  type RevisionRecord,
} from './activity';

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

/** Simple, non-cryptographic content hash suitable for deterministic tests. */
function hashContent(content: string): string {
  let hash = 5381;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 33) ^ content.charCodeAt(index);
  }
  return `blob-${(hash >>> 0).toString(16)}`;
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

describe('computeRevisionDiff', () => {
  it('reports added, removed and context lines against the parent', () => {
    const diff = computeRevisionDiff('alpha\nbeta\ngamma\n', 'alpha\ndelta\ngamma\n');
    expect(diff.rows).toEqual([
      { type: 'context', text: 'alpha' },
      { type: 'removed', text: 'beta' },
      { type: 'added', text: 'delta' },
      { type: 'context', text: 'gamma' },
    ]);
  });

  it('treats a create as fully added and a delete as fully removed', () => {
    expect(computeRevisionDiff(null, 'one\ntwo\n').rows).toEqual([
      { type: 'added', text: 'one' },
      { type: 'added', text: 'two' },
    ]);
    expect(computeRevisionDiff('gone\n', null).rows).toEqual([
      { type: 'removed', text: 'gone' },
    ]);
    expect(computeRevisionDiff(null, null).rows).toEqual([]);
  });
});

describe('restoreRevision', () => {
  // Bob deleted line "A", leaving only "B". Restoring r1 must reintroduce "A"
  // as the restorer's own work while the surviving "B" keeps Bob's attribution.
  const initial = record({ revisionId: 'r1', content: 'A\nB\n', timestamp: 1 });
  const edited = record({
    revisionId: 'r2',
    content: 'B\n',
    timestamp: 2,
    kind: 'edit',
    actor: { kind: 'author', actorId: 'a-bob', displayName: 'Bob' },
    parentRevisionIds: ['r1'],
    provenance: createInitialProvenance('B\n', 'r2'),
  });

  it('creates a NEW revision attributed to the restorer without rewriting history', () => {
    const history = [initial, edited];
    const result = restoreRevision({
      history,
      targetRevisionId: 'r1',
      restorer: { actorId: 'a-ana', displayName: 'Ana' },
      now: 3,
      newRevisionId: 'r3',
      hashContent,
    });

    // A brand-new revision id, never reusing the target.
    expect(result.revision.revisionId).toBe('r3');
    expect(result.revision.revisionId).not.toBe('r1');

    // Append-only: parent is the current head, not the restored revision.
    expect(result.revision.parentRevisionIds).toEqual(['r2']);

    // Restored content equals the historical target content.
    expect(result.reconstructedContent).toBe('A\nB\n');
    expect(result.record.content).toBe('A\nB\n');

    // Attribution: the restorer authored it, and the source history is recorded.
    expect(result.record.actor).toEqual({
      kind: 'author',
      actorId: 'a-ana',
      displayName: 'Ana',
    });
    expect(result.record.restoredFromRevisionId).toBe('r1');
    expect(result.record.kind).toBe('edit');
    expect(result.record.timestamp).toBe(3);

    // The reintroduced line "A" is attributed to the new (restore) revision;
    // the surviving line "B" keeps its original source attribution (Bob's r2).
    expect(result.record.provenance).toEqual([
      { length: 'A\n'.length, sourceRevisionId: 'r3' },
      { length: 'B\n'.length, sourceRevisionId: 'r2' },
    ]);

    // The original history is untouched (no mutation of the input records).
    expect(history[0]).toBe(initial);
    expect(initial.content).toBe('A\nB\n');

    // The new revision extends the append-only DAG by exactly one node.
    const dag = new RevisionDag();
    for (const entry of history) {
      dag.add({
        revisionId: entry.revisionId,
        vaultId: entry.vaultId,
        fileId: entry.fileId,
        parentRevisionIds: entry.parentRevisionIds,
        blobHash: entry.blobHash,
      });
    }
    const sizeBefore = dag.size;
    expect(dag.add(result.revision)).toBe('accepted');
    expect(dag.size).toBe(sizeBefore + 1);
    expect(dag.getHeads(VAULT, FILE)).toEqual(['r3']);
  });

  it('rejects reusing an existing revision id (never a silent overwrite)', () => {
    expect(() =>
      restoreRevision({
        history: [initial, edited],
        targetRevisionId: 'r1',
        restorer: { actorId: 'a-ana', displayName: 'Ana' },
        now: 3,
        newRevisionId: 'r2',
        hashContent,
      }),
    ).toThrow(ActivityError);
  });

  it('fails when the target revision is unknown', () => {
    expect(() =>
      restoreRevision({
        history: [initial],
        targetRevisionId: 'missing',
        restorer: { actorId: 'a-ana', displayName: 'Ana' },
        now: 3,
        newRevisionId: 'r9',
        hashContent,
      }),
    ).toThrow(/unknown target revision/i);
  });

  it('refuses to restore the content of a deletion', () => {
    const deletion = record({
      revisionId: 'rdel',
      content: null,
      kind: 'delete',
      timestamp: 2,
      parentRevisionIds: ['r1'],
    });
    expect(() =>
      restoreRevision({
        history: [initial, deletion],
        targetRevisionId: 'rdel',
        restorer: { actorId: 'a-ana', displayName: 'Ana' },
        now: 3,
        newRevisionId: 'r9',
        hashContent,
      }),
    ).toThrow(/deleted revision/i);
  });

  it('refuses to restore while the file history has unreconciled heads', () => {
    const forkA = record({
      revisionId: 'fa',
      content: 'fork a\n',
      timestamp: 2,
      kind: 'edit',
      parentRevisionIds: ['r1'],
      provenance: createInitialProvenance('fork a\n', 'fa'),
    });
    const forkB = record({
      revisionId: 'fb',
      content: 'fork b\n',
      timestamp: 3,
      kind: 'edit',
      parentRevisionIds: ['r1'],
      provenance: createInitialProvenance('fork b\n', 'fb'),
    });
    expect(() =>
      restoreRevision({
        history: [initial, forkA, forkB],
        targetRevisionId: 'r1',
        restorer: { actorId: 'a-ana', displayName: 'Ana' },
        now: 4,
        newRevisionId: 'r9',
        hashContent,
      }),
    ).toThrow(/single reconciled head/i);
  });

  it('restores content even when the current head is a deletion', () => {
    const created = record({ revisionId: 'd1', content: 'X\n', timestamp: 1 });
    const deleted = record({
      revisionId: 'd2',
      content: null,
      kind: 'delete',
      timestamp: 2,
      parentRevisionIds: ['d1'],
    });
    const result = restoreRevision({
      history: [created, deleted],
      targetRevisionId: 'd1',
      restorer: { actorId: 'a-ana', displayName: 'Ana' },
      now: 3,
      newRevisionId: 'd3',
      hashContent,
    });
    expect(result.revision.parentRevisionIds).toEqual(['d2']);
    expect(result.reconstructedContent).toBe('X\n');
    expect(result.record.provenance).toEqual([
      { length: 'X\n'.length, sourceRevisionId: 'd3' },
    ]);
    expect(result.record.restoredFromRevisionId).toBe('d1');
  });

  it('restores onto an empty file (create) and attributes the whole body to the restorer', () => {
    const created = record({ revisionId: 'c1', content: 'hello\n', timestamp: 1 });
    const cleared = record({
      revisionId: 'c2',
      content: '',
      timestamp: 2,
      kind: 'edit',
      parentRevisionIds: ['c1'],
      provenance: [],
    });
    const result = restoreRevision({
      history: [created, cleared],
      targetRevisionId: 'c1',
      restorer: { actorId: 'a-ana', displayName: 'Ana' },
      now: 3,
      newRevisionId: 'c3',
      hashContent,
    });
    expect(result.reconstructedContent).toBe('hello\n');
    expect(result.record.provenance).toEqual([
      { length: 'hello\n'.length, sourceRevisionId: 'c3' },
    ]);
    expect(result.revision.blobHash).toBe(hashContent('hello\n'));
  });
});

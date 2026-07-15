import { describe, expect, it } from 'vitest';

import {
  RevisionDag,
  RevisionDagError,
  type RevisionNode,
} from './revision-dag.js';

function revision(
  revisionId: string,
  parentRevisionIds: readonly string[] = [],
  overrides: Partial<RevisionNode> = {},
): RevisionNode {
  return {
    revisionId,
    vaultId: 'vault-a',
    fileId: 'file-a',
    parentRevisionIds,
    blobHash: `hash-${revisionId}`,
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('Expected RevisionDagError.');
  } catch (error) {
    expect(error).toBeInstanceOf(RevisionDagError);
    expect((error as RevisionDagError).code).toBe(code);
  }
}

describe('RevisionDag', () => {
  it('advances a single current head', () => {
    const dag = new RevisionDag();

    expect(dag.add(revision('r1'))).toBe('accepted');
    expect(dag.add(revision('r2', ['r1']))).toBe('accepted');
    expect(dag.getHeads('vault-a', 'file-a')).toEqual(['r2']);
  });

  it('preserves stale-parent revisions as concurrent heads', () => {
    const dag = new RevisionDag();
    dag.add(revision('r1'));
    dag.add(revision('r2', ['r1']));
    dag.add(revision('r3', ['r1']));

    expect(dag.getHeads('vault-a', 'file-a')).toEqual(['r2', 'r3']);
  });

  it('accepts reconciliation only for the exact current head set', () => {
    const dag = new RevisionDag();
    dag.addBatch([
      revision('r1'),
      revision('r2', ['r1']),
      revision('r3', ['r1']),
    ]);

    dag.add(revision('merge-1', ['r2', 'r3']));
    expect(dag.getHeads('vault-a', 'file-a')).toEqual(['merge-1']);

    expectCode(
      () => dag.add(revision('merge-2', ['r2', 'r3'])),
      'HEAD_SET_CHANGED',
    );
  });

  it('replays byte-identical revisions and rejects ID reuse', () => {
    const dag = new RevisionDag();
    const first = revision('r1');

    expect(dag.add(first)).toBe('accepted');
    expect(dag.add({ ...first })).toBe('replayed');
    expectCode(
      () => dag.add({ ...first, blobHash: 'different' }),
      'REVISION_ID_REUSE',
    );
    expectCode(
      () =>
        dag.add(
          revision('r1', [], {
            vaultId: 'vault-b',
            fileId: 'file-b',
          }),
        ),
      'REVISION_ID_REUSE',
    );
  });

  it('rejects invalid parent relationships and ordering', () => {
    const dag = new RevisionDag();
    dag.add(revision('r1'));

    expectCode(() => dag.add(revision('self', ['self'])), 'SELF_PARENT');
    expectCode(
      () => dag.add(revision('duplicate', ['r1', 'r1'])),
      'DUPLICATE_PARENT',
    );
    expectCode(
      () => dag.add(revision('unsorted', ['z-parent', 'a-parent'])),
      'UNSORTED_PARENTS',
    );
    expectCode(
      () => dag.add(revision('missing', ['not-found'])),
      'PARENT_NOT_FOUND',
    );
    expectCode(
      () =>
        dag.add(
          revision('wrong-file', ['r1'], {
            fileId: 'file-b',
          }),
        ),
      'PARENT_FILE_MISMATCH',
    );
    expectCode(() => dag.add(revision('second-root')), 'FILE_ALREADY_EXISTS');
  });

  it('applies a batch atomically and requires topological order', () => {
    const dag = new RevisionDag();

    expectCode(
      () =>
        dag.addBatch([
          revision('r2', ['r1']),
          revision('r1'),
        ]),
      'BATCH_NOT_TOPOLOGICAL',
    );
    expect(dag.size).toBe(0);

    expectCode(
      () =>
        dag.addBatch([
          revision('r1'),
          revision('r2', ['r1']),
          revision('bad', ['missing']),
        ]),
      'PARENT_NOT_FOUND',
    );
    expect(dag.size).toBe(0);

    expect(dag.addBatch([revision('r1'), revision('r2', ['r1'])])).toEqual([
      'accepted',
      'accepted',
    ]);
  });
});

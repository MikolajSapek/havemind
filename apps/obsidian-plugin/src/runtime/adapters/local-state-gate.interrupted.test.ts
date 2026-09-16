/**
 * An interrupted bootstrap must not be mistaken for healthy history.
 *
 * `runSnapshotBootstrap` records a path owner per materialised head but saves the
 * cursor once, at the end. A join that does not finish (iOS backgrounding the
 * app during a long bootstrap) therefore leaves cursor zero alongside hundreds of
 * owned paths. The gate used to read those owned paths as evidence of a healthy
 * client and allow the connect, so the next session replayed the whole history
 * over an already-populated vault: connect-time reconcile saw materialised notes
 * with no producer mapping, pushed them as fresh local creates under new fileIds,
 * and the owner got long-deleted notes back plus a wall of empty
 * "Target unknown" conflict copies.
 */

import { describe, expect, it } from 'vitest';

import { gateLocalSyncState } from './local-state-gate';

function blob(overrides: {
  cursor: number;
  ownedPaths: number;
  mappings?: number;
  outbox?: number;
  locallyAuthored?: number;
}) {
  const pathOwners: Record<string, string> = {};
  for (let i = 0; i < overrides.ownedPaths; i += 1) {
    pathOwners[`Notes/note-${i}.md`] = `file-${i}`;
  }
  const mappingCount = overrides.mappings ?? overrides.ownedPaths;
  return {
    syncState: {
      version: 1,
      cursor: overrides.cursor,
      outbox: Array.from({ length: overrides.outbox ?? 0 }, (_, i) => ({
        revisionId: `queued-${i}`,
      })),
      locallyAuthored: Array.from(
        { length: overrides.locallyAuthored ?? 0 },
        (_, i) => `authored-${i}`,
      ),
      deferred: [],
      pathOwners,
    },
    pushProducer: {
      mappings: Array.from({ length: mappingCount }, (_, i) => ({
        collisionKey: `notes/note-${i}.md`,
        content: 'REMOTE\n',
        contentHash: `hash-${i}`,
        fileId: `file-${i}`,
        path: `Notes/note-${i}.md`,
      })),
      heads: {},
    },
  };
}

describe('local state gate, interrupted bootstrap', () => {
  it('flags a connect whose bootstrap materialised heads but never saved a cursor', () => {
    // Not `recovery-required`: the state is not damaged, the join simply did not
    // finish, and finishing it is safe. What is NOT safe is letting connect-time
    // reconcile run first and push those materialised heads back as local
    // creates, so the gate asks the caller to resume the bootstrap instead.
    const gate = gateLocalSyncState(blob({ cursor: 0, ownedPaths: 120 }));
    expect(gate).toEqual({ kind: 'resume-bootstrap' });
  });

  it('still allows a genuine first connection with nothing materialised', () => {
    expect(gateLocalSyncState({})).toEqual({ kind: 'allow' });
    expect(gateLocalSyncState(blob({ cursor: 0, ownedPaths: 0, mappings: 0 }))).toEqual(
      { kind: 'allow' },
    );
  });

  it('allows a cursor-zero client whose only history is its own queued work', () => {
    // A device that authored a revision before its first pull landed is not an
    // interrupted bootstrap: it owns no materialised remote path.
    const gate = gateLocalSyncState(
      blob({ cursor: 0, ownedPaths: 0, mappings: 1, outbox: 1 }),
    );
    expect(gate.kind).toBe('allow');
  });

  it('allows a normal device that has a cursor', () => {
    expect(gateLocalSyncState(blob({ cursor: 42, ownedPaths: 120 })).kind).toBe(
      'allow',
    );
  });
});

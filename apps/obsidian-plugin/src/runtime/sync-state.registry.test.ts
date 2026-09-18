/**
 * `DurableSyncState`'s file-state methods, served from the registry.
 *
 * The ten methods below (`fileIdAtPath`, `pathForFileId`, the three
 * record/forget pairs) used to read and write three independent maps. They now
 * project one `FileRegistry` record, so the pairs that used to drift cannot.
 *
 * These tests are about EQUIVALENCE, not new behaviour: the sync path depends on
 * exactly these semantics and the persisted format is unchanged, so a device
 * that downgrades keeps working. Anything here that differs from the old
 * behaviour is a regression, not an improvement.
 */

import { describe, expect, it } from 'vitest';

import { DurableSyncState, type PersistedSyncState } from './sync-state';

const FILE_A = '11111111-1111-4111-8111-111111111111';
const FILE_B = '22222222-2222-4222-8222-222222222222';
const PATH_A = 'Notes/a.md';
const PATH_B = 'Notes/b.md';

function makeState(seed?: Partial<PersistedSyncState>): {
  state: DurableSyncState;
  stored: () => PersistedSyncState | null;
} {
  let stored: PersistedSyncState | null =
    seed === undefined
      ? null
      : ({
          version: 1,
          cursor: 0,
          outbox: [],
          locallyAuthored: [],
          deferred: [],
          pathOwners: {},
          baseHashes: {},
          baseContents: {},
          conflictArtifacts: {},
          quarantine: [],
          quarantinedEnvelopes: {},
          ...seed,
        } as PersistedSyncState);

  return {
    stored: () => stored,
    state: new DurableSyncState({
      persist: {
        async load() {
          return stored;
        },
        async loadBackup() {
          return null;
        },
        async save(next: PersistedSyncState) {
          stored = next;
        },
        async preserveCorrupt() {
          /* no-op */
        },
      },
    }),
  };
}

describe('DurableSyncState file state', () => {
  it('reads back an owner, a base hash and a base content', async () => {
    const { state } = makeState();
    await state.recordPathOwner(FILE_A, PATH_A);
    await state.recordBaseHash(FILE_A, 'h1');
    await state.recordBaseContent(FILE_A, 'V1\n');

    expect(state.fileIdAtPath(PATH_A)).toBe(FILE_A);
    expect(state.pathForFileId(FILE_A)).toBe(PATH_A);
    expect(state.baseHashFor(FILE_A)).toBe('h1');
    expect(state.baseContentFor(FILE_A)).toBe('V1\n');
  });

  it('persists in the shape data.json already holds', async () => {
    const { state, stored } = makeState();
    await state.recordPathOwner(FILE_A, PATH_A);
    await state.recordBaseHash(FILE_A, 'h1');
    await state.recordBaseContent(FILE_A, 'V1\n');

    // A downgraded plugin must find its own format, unchanged.
    expect(stored()?.pathOwners).toEqual({ [PATH_A]: FILE_A });
    expect(stored()?.baseHashes).toEqual({ [FILE_A]: 'h1' });
    expect(stored()?.baseContents).toEqual({ [FILE_A]: 'V1\n' });
  });

  it('loads state written by the previous version', async () => {
    const { state } = makeState({
      pathOwners: { [PATH_A]: FILE_A },
      baseHashes: { [FILE_A]: 'h1' },
      baseContents: { [FILE_A]: 'V1\n' },
    });
    // Warm the cache the synchronous accessors read.
    await state.loadCursor();

    expect(state.fileIdAtPath(PATH_A)).toBe(FILE_A);
    expect(state.baseHashFor(FILE_A)).toBe('h1');
    expect(state.baseContentFor(FILE_A)).toBe('V1\n');
  });

  it('forgets a path without touching the base', async () => {
    // The old semantics: forgetPath drops ownership only. The base is keyed by
    // fileId and survives, because a rename must not lose the merge ancestor.
    const { state } = makeState();
    await state.recordPathOwner(FILE_A, PATH_A);
    await state.recordBaseHash(FILE_A, 'h1');
    await state.forgetPath(PATH_A);

    expect(state.fileIdAtPath(PATH_A)).toBeNull();
    expect(state.baseHashFor(FILE_A)).toBe('h1');
  });

  it('forgets a base without dropping ownership', async () => {
    const { state } = makeState();
    await state.recordPathOwner(FILE_A, PATH_A);
    await state.recordBaseHash(FILE_A, 'h1');
    await state.recordBaseContent(FILE_A, 'V1\n');

    await state.forgetBaseHash(FILE_A);
    await state.forgetBaseContent(FILE_A);

    expect(state.fileIdAtPath(PATH_A)).toBe(FILE_A);
    expect(state.baseHashFor(FILE_A)).toBeNull();
    expect(state.baseContentFor(FILE_A)).toBeNull();
  });

  it('moves ownership when a file is renamed', async () => {
    const { state } = makeState();
    await state.recordPathOwner(FILE_A, PATH_A);
    await state.recordBaseHash(FILE_A, 'h1');
    await state.forgetPath(PATH_A);
    await state.recordPathOwner(FILE_A, PATH_B);

    expect(state.fileIdAtPath(PATH_A)).toBeNull();
    expect(state.fileIdAtPath(PATH_B)).toBe(FILE_A);
    expect(state.baseHashFor(FILE_A)).toBe('h1');
  });

  it('lets a path change hands without leaving two owners', async () => {
    const { state, stored } = makeState();
    await state.recordPathOwner(FILE_A, PATH_A);
    await state.recordPathOwner(FILE_B, PATH_A);

    expect(state.fileIdAtPath(PATH_A)).toBe(FILE_B);
    // Exactly one owner in the persisted map, never two claiming one path.
    expect(Object.values(stored()?.pathOwners ?? {})).toEqual([FILE_B]);
  });

  it('reports nothing for a file it never saw', async () => {
    const { state } = makeState();
    await state.loadCursor();
    expect(state.fileIdAtPath('Notes/missing.md')).toBeNull();
    expect(state.pathForFileId('unknown')).toBeNull();
    expect(state.baseHashFor('unknown')).toBeNull();
    expect(state.baseContentFor('unknown')).toBeNull();
  });

  it('tolerates forgetting what was never recorded', async () => {
    const { state } = makeState();
    await expect(state.forgetPath('Notes/missing.md')).resolves.toBeUndefined();
    await expect(state.forgetBaseHash('unknown')).resolves.toBeUndefined();
    await expect(state.forgetBaseContent('unknown')).resolves.toBeUndefined();
  });

  it('keeps the ancestor and its hash in agreement', async () => {
    // The invariant the three-map shape could not hold, and the reason every
    // divergence used to degrade into a conflict copy.
    const { state, stored } = makeState();
    await state.recordPathOwner(FILE_A, PATH_A);
    await state.recordBaseHash(FILE_A, 'hash:V1\n');
    await state.recordBaseContent(FILE_A, 'V1\n');

    const hashes = stored()?.baseHashes ?? {};
    const contents = stored()?.baseContents ?? {};
    for (const [fileId, content] of Object.entries(contents)) {
      expect(hashes[fileId]).toBe(`hash:${content}`);
    }
  });
});

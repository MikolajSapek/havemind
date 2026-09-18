/**
 * The registry has to read and write the state already on disk.
 *
 * `data.json` stores the agreed state as three separate maps (`pathOwners`,
 * `baseHashes`, `baseContents`) and the producer's own blob stores `mappings` +
 * `heads`. Every installed device holds that shape today, so the registry
 * cannot simply adopt a new format: it must load the old one, and write it back
 * so that a user who downgrades the plugin still has a working vault.
 *
 * The conversion is where a migration typically loses something. These tests
 * pin that it does not: a file present in the old maps survives the round trip
 * with every field intact, and a half-written old state (a base hash whose
 * content was never recorded, which the old six-method shape allowed) converts
 * into a coherent record rather than carrying the inconsistency forward.
 */

import { describe, expect, it } from 'vitest';

import {
  registryFromPersistedState,
  registryToPersistedState,
  type PersistedFileState,
} from './registry-persistence';

const FILE_A = 'file-a';
const FILE_B = 'file-b';
const PATH_A = 'Notes/a.md';
const PATH_B = 'Notes/b.md';

describe('registry persistence', () => {
  it('loads the three maps the plugin already stores', () => {
    const files = registryFromPersistedState({
      pathOwners: { [PATH_A]: FILE_A },
      baseHashes: { [FILE_A]: 'h1' },
      baseContents: { [FILE_A]: 'V1\n' },
    });

    const record = files.byFileId(FILE_A);
    expect(record?.path).toBe(PATH_A);
    expect(record?.agreedHash).toBe('h1');
    expect(record?.agreedContent).toBe('V1\n');
    expect(files.byPath(PATH_A)?.fileId).toBe(FILE_A);
  });

  it('writes back exactly the shape it read', () => {
    const state: PersistedFileState = {
      pathOwners: { [PATH_A]: FILE_A, [PATH_B]: FILE_B },
      baseHashes: { [FILE_A]: 'h1', [FILE_B]: 'h2' },
      baseContents: { [FILE_A]: 'V1\n', [FILE_B]: 'V2\n' },
    };

    const round = registryToPersistedState(registryFromPersistedState(state));

    expect(round).toEqual(state);
  });

  it('keeps a base hash whose content was never recorded', () => {
    // The old six-method shape allowed this: a binary attachment records a hash
    // and no body. Dropping it would silently make every binary look divergent.
    const files = registryFromPersistedState({
      pathOwners: { [PATH_A]: FILE_A },
      baseHashes: { [FILE_A]: 'binary-hash' },
      baseContents: {},
    });

    expect(files.byFileId(FILE_A)?.agreedHash).toBe('binary-hash');
    expect(files.byFileId(FILE_A)?.agreedContent).toBeNull();
    expect(registryToPersistedState(files).baseHashes[FILE_A]).toBe('binary-hash');
  });

  it('keeps a base recorded for a file with no path owner', () => {
    // Also reachable in the old shape, and the base is still the merge ancestor
    // the file needs, so it must not be discarded on the way through.
    const files = registryFromPersistedState({
      pathOwners: {},
      baseHashes: { [FILE_A]: 'h1' },
      baseContents: { [FILE_A]: 'V1\n' },
    });

    expect(files.byFileId(FILE_A)?.agreedHash).toBe('h1');
    const written = registryToPersistedState(files);
    expect(written.baseHashes[FILE_A]).toBe('h1');
    expect(written.baseContents[FILE_A]).toBe('V1\n');
  });

  it('survives an empty state', () => {
    const files = registryFromPersistedState({
      pathOwners: {},
      baseHashes: {},
      baseContents: {},
    });
    expect([...files.all()]).toHaveLength(0);
    expect(registryToPersistedState(files)).toEqual({
      pathOwners: {},
      baseHashes: {},
      baseContents: {},
    });
  });

  it('ignores a path owner pointing at nothing else', () => {
    // A path owner with no base at all is a file the apply side knows the
    // identity of but has never agreed content for. It must survive, because
    // dropping it would let a second fileId claim the same path.
    const files = registryFromPersistedState({
      pathOwners: { [PATH_A]: FILE_A },
      baseHashes: {},
      baseContents: {},
    });

    expect(files.byPath(PATH_A)?.fileId).toBe(FILE_A);
    expect(registryToPersistedState(files).pathOwners[PATH_A]).toBe(FILE_A);
  });

  it('round-trips a vault of many files without loss', () => {
    const pathOwners: Record<string, string> = {};
    const baseHashes: Record<string, string> = {};
    const baseContents: Record<string, string> = {};
    for (let index = 0; index < 200; index += 1) {
      const fileId = `file-${index}`;
      pathOwners[`Notes/note-${index}.md`] = fileId;
      baseHashes[fileId] = `hash-${index}`;
      baseContents[fileId] = `content ${index}\n`;
    }
    const state: PersistedFileState = { pathOwners, baseHashes, baseContents };

    expect(registryToPersistedState(registryFromPersistedState(state))).toEqual(
      state,
    );
  });
});

/**
 * The conversion must not lose or invent state for ANY shape data.json holds.
 *
 * Today's repair scripts needed three attempts each because a conversion looked
 * right on the cases someone wrote down and silently dropped a field on the
 * ones they did not. Generating the persisted maps directly, including the
 * half-written combinations the old six-method shape allowed, checks the
 * property that actually matters: what goes in comes back out.
 */
describe('persistence round-trip over arbitrary states', () => {
  it('returns exactly what it was given', async () => {
    const fc = (await import('fast-check')).default;

    const fileIdArb = fc.constantFrom('f1', 'f2', 'f3', 'f4');
    const pathArb = fc.constantFrom('A.md', 'B.md', 'C.md', 'D.md');

    fc.assert(
      fc.property(
        // Independent maps, so every combination of "owner without base",
        // "base without owner" and "hash without content" is generated.
        fc.dictionary(pathArb, fileIdArb),
        fc.dictionary(fileIdArb, fc.constantFrom('h1', 'h2')),
        fc.dictionary(fileIdArb, fc.constantFrom('c1', 'c2')),
        (pathOwners, baseHashes, baseContents) => {
          // A path map is only meaningful when each file claims one path; two
          // paths naming the same file is not a state the plugin can produce.
          const claimed = new Set(Object.values(pathOwners));
          if (claimed.size !== Object.keys(pathOwners).length) return;

          const state = { pathOwners, baseHashes, baseContents };
          const round = registryToPersistedState(
            registryFromPersistedState(state),
          );
          expect(round).toEqual(state);
        },
      ),
      { numRuns: 400 },
    );
  });
});

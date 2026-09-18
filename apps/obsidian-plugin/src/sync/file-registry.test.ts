/**
 * One registry per file, one owner, one write.
 *
 * The plugin currently keeps the same truth twice. The producer side holds
 * `mappings[collisionKey]` (fileId, path, content, contentHash) plus
 * `heads[fileId]`; the apply side holds `pathOwners[path]`, `baseHashes[fileId]`
 * and `baseContents[fileId]`. Nothing structural keeps them in agreement:
 * `vault-apply.ts` alone has 42 writes to the apply side and 20 paired calls
 * into the producer side, so 22 writes have no partner and correctness rests on
 * a human noticing the pairing at every new branch. The codebase carries two
 * "order matters" comments marking historical bugs of exactly this class.
 *
 * `FileRegistry` replaces both with a single record per file, written through
 * one method per real-world event. The events are the vocabulary the rest of the
 * sync code already speaks:
 *
 *   authoredLocally   - this device wrote the file and queued a revision
 *   agreedWithPeer    - both sides are known to hold this content (remote apply,
 *                       convergence, or the server echoing our own push back)
 *   removed           - the file is gone
 *
 * The merge ancestor and its hash can no longer disagree, because they are two
 * fields of one record set in one assignment, and a file's identity cannot be
 * half-updated, because there is only one place to update it.
 */

import { describe, expect, it } from 'vitest';

import { FileRegistry, type FileRecord } from './file-registry';

const FILE_A = 'file-a';
const FILE_B = 'file-b';
const PATH_A = 'Notes/a.md';
const PATH_B = 'Notes/b.md';

function registry(seed: readonly FileRecord[] = []): FileRegistry {
  return new FileRegistry(seed);
}

describe('FileRegistry', () => {
  describe('local authorship', () => {
    it('records a file this device authored', () => {
      const files = registry();
      files.authoredLocally({
        fileId: FILE_A,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'V1\n',
        contentHash: 'h1',
        headRevisionId: 'rev-1',
      });

      const record = files.byFileId(FILE_A);
      expect(record?.path).toBe(PATH_A);
      expect(record?.headRevisionId).toBe('rev-1');
      // First authorship seeds the agreed content: there is nothing older to
      // preserve, and a file with no ancestor at all can never merge.
      expect(record?.agreedContent).toBe('V1\n');
      expect(record?.agreedHash).toBe('h1');
    });

    it('does not move the agreed content on a later local edit', () => {
      // The invariant from local-base-lifecycle.ts: a local write cannot prove
      // the peer holds the same bytes, so the agreed state must not follow it.
      const files = registry();
      files.authoredLocally({
        fileId: FILE_A,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'V1\n',
        contentHash: 'h1',
        headRevisionId: 'rev-1',
      });
      files.authoredLocally({
        fileId: FILE_A,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'V2\n',
        contentHash: 'h2',
        headRevisionId: 'rev-2',
      });

      const record = files.byFileId(FILE_A);
      expect(record?.localContent).toBe('V2\n');
      expect(record?.headRevisionId).toBe('rev-2');
      expect(record?.agreedContent).toBe('V1\n');
      expect(record?.agreedHash).toBe('h1');
    });
  });

  describe('agreement with the peer', () => {
    it('moves the agreed state and the local view together', () => {
      const files = registry();
      files.authoredLocally({
        fileId: FILE_A,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'V1\n',
        contentHash: 'h1',
        headRevisionId: 'rev-1',
      });
      files.agreedWithPeer({
        fileId: FILE_A,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'V2\n',
        contentHash: 'h2',
        headRevisionId: 'rev-2',
      });

      const record = files.byFileId(FILE_A);
      expect(record?.agreedContent).toBe('V2\n');
      expect(record?.agreedHash).toBe('h2');
      expect(record?.localContent).toBe('V2\n');
      expect(record?.headRevisionId).toBe('rev-2');
    });

    it('adopts a file this device has never seen', () => {
      const files = registry();
      files.agreedWithPeer({
        fileId: FILE_B,
        path: PATH_B,
        collisionKey: 'notes/b.md',
        content: 'REMOTE\n',
        contentHash: 'hb',
        headRevisionId: 'rev-b',
      });
      expect(files.byPath(PATH_B)?.fileId).toBe(FILE_B);
    });
  });

  describe('the invariant the old split could not hold', () => {
    it('never lets the agreed hash disagree with the agreed content', () => {
      // In the old shape `baseHashes[fileId]` and `baseContents[fileId]` were
      // separate maps with separate writers, so a partial update left the merge
      // precondition (hash(ancestor) === base) permanently unsatisfiable and
      // every divergence degraded to a conflict copy.
      const files = registry();
      const hashOf = (content: string): string => `hash:${content}`;

      files.authoredLocally({
        fileId: FILE_A,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'V1\n',
        contentHash: hashOf('V1\n'),
        headRevisionId: 'rev-1',
      });
      files.agreedWithPeer({
        fileId: FILE_A,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'V2\n',
        contentHash: hashOf('V2\n'),
        headRevisionId: 'rev-2',
      });

      for (const record of files.all()) {
        if (record.agreedContent === null) continue;
        expect(record.agreedHash).toBe(hashOf(record.agreedContent));
      }
    });

    it('never leaves a path pointing at a file that is gone', () => {
      const files = registry();
      files.authoredLocally({
        fileId: FILE_A,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'V1\n',
        contentHash: 'h1',
        headRevisionId: 'rev-1',
      });
      files.removed(FILE_A);

      expect(files.byFileId(FILE_A)).toBeUndefined();
      expect(files.byPath(PATH_A)).toBeUndefined();
      expect(files.byCollisionKey('notes/a.md')).toBeUndefined();
    });

    it('moves every index together on a rename', () => {
      // The old shape needed `forgetPath(old)` and `recordPathOwner(new)` in the
      // right order, and got it wrong twice in production.
      const files = registry();
      files.authoredLocally({
        fileId: FILE_A,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'V1\n',
        contentHash: 'h1',
        headRevisionId: 'rev-1',
      });
      files.agreedWithPeer({
        fileId: FILE_A,
        path: PATH_B,
        collisionKey: 'notes/b.md',
        content: 'V1\n',
        contentHash: 'h1',
        headRevisionId: 'rev-2',
      });

      expect(files.byPath(PATH_A)).toBeUndefined();
      expect(files.byCollisionKey('notes/a.md')).toBeUndefined();
      expect(files.byPath(PATH_B)?.fileId).toBe(FILE_A);
      expect(files.byFileId(FILE_A)?.path).toBe(PATH_B);
    });

    it('retires the previous owner when a path changes hands', () => {
      // Two devices minted different fileIds for the same path. Exactly one
      // record may own it afterwards, with no orphan left behind.
      const files = registry();
      files.authoredLocally({
        fileId: FILE_A,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'MINE\n',
        contentHash: 'h1',
        headRevisionId: 'rev-1',
      });
      files.agreedWithPeer({
        fileId: FILE_B,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'THEIRS\n',
        contentHash: 'h2',
        headRevisionId: 'rev-2',
      });

      expect(files.byPath(PATH_A)?.fileId).toBe(FILE_B);
      expect(files.byFileId(FILE_A)).toBeUndefined();
      expect([...files.all()]).toHaveLength(1);
    });
  });

  describe('persistence', () => {
    it('round-trips through its serialised form', () => {
      const files = registry();
      files.authoredLocally({
        fileId: FILE_A,
        path: PATH_A,
        collisionKey: 'notes/a.md',
        content: 'V1\n',
        contentHash: 'h1',
        headRevisionId: 'rev-1',
      });
      files.agreedWithPeer({
        fileId: FILE_B,
        path: PATH_B,
        collisionKey: 'notes/b.md',
        content: 'REMOTE\n',
        contentHash: 'hb',
        headRevisionId: 'rev-b',
      });

      const restored = new FileRegistry(files.toJSON());
      expect(restored.byFileId(FILE_A)).toEqual(files.byFileId(FILE_A));
      expect(restored.byPath(PATH_B)).toEqual(files.byPath(PATH_B));
    });

    it('drops malformed records rather than throwing', () => {
      // data.json is untrusted input: a damaged entry must not stop the plugin.
      const restored = new FileRegistry([
        { fileId: FILE_A } as unknown as FileRecord,
        {
          fileId: FILE_B,
          path: PATH_B,
          collisionKey: 'notes/b.md',
          localContent: 'ok\n',
          localHash: 'hb',
          agreedContent: 'ok\n',
          agreedHash: 'hb',
          headRevisionId: 'rev-b',
          contentKind: 'markdown',
        },
      ]);
      expect([...restored.all()]).toHaveLength(1);
      expect(restored.byFileId(FILE_B)?.path).toBe(PATH_B);
    });
  });
});

/**
 * `patch` exists for the migration period only.
 *
 * `vault-apply.ts` still writes the agreed state through six separate methods
 * (record/forget × path, hash, content), so during the move onto this registry
 * a caller sometimes has only ONE of those fields in hand. `patch` lets that
 * caller set one field without blanking the others, while still keeping every
 * field on one record. Once all 42 call sites speak in events, this goes away.
 */
describe('FileRegistry.patch', () => {
  it('creates a record from a single field', () => {
    const files = registry();
    files.patch(FILE_A, { path: PATH_A, collisionKey: 'notes/a.md' });
    expect(files.byPath(PATH_A)?.fileId).toBe(FILE_A);
  });

  it('changes one field and leaves the rest alone', () => {
    const files = registry();
    files.agreedWithPeer({
      fileId: FILE_A,
      path: PATH_A,
      collisionKey: 'notes/a.md',
      content: 'V1\n',
      contentHash: 'h1',
      headRevisionId: 'rev-1',
    });

    files.patch(FILE_A, { agreedHash: 'h2' });

    const record = files.byFileId(FILE_A);
    expect(record?.agreedHash).toBe('h2');
    expect(record?.agreedContent).toBe('V1\n');
    expect(record?.headRevisionId).toBe('rev-1');
    expect(record?.path).toBe(PATH_A);
  });

  it('can clear a field explicitly', () => {
    const files = registry();
    files.agreedWithPeer({
      fileId: FILE_A,
      path: PATH_A,
      collisionKey: 'notes/a.md',
      content: 'V1\n',
      contentHash: 'h1',
      headRevisionId: 'rev-1',
    });

    files.patch(FILE_A, { agreedContent: null, agreedHash: null });

    const record = files.byFileId(FILE_A);
    expect(record?.agreedContent).toBeNull();
    expect(record?.agreedHash).toBeNull();
    // The file itself still exists: clearing the agreed state is not a delete.
    expect(files.byPath(PATH_A)?.fileId).toBe(FILE_A);
  });

  it('moves the indexes when the path changes', () => {
    const files = registry();
    files.patch(FILE_A, { path: PATH_A, collisionKey: 'notes/a.md' });
    files.patch(FILE_A, { path: PATH_B, collisionKey: 'notes/b.md' });

    expect(files.byPath(PATH_A)).toBeUndefined();
    expect(files.byPath(PATH_B)?.fileId).toBe(FILE_A);
  });
});

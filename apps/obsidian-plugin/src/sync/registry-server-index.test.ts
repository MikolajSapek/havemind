/**
 * The server index reconcile needs is already in the registry after a join.
 *
 * Adoption needs to know which contents the vault already holds. Asking the
 * server would mean downloading every blob just to hash it, because the
 * plaintext hash lives inside the payload rather than in the receipt header.
 *
 * But the bootstrap has just materialised every one of those files, so the
 * registry already holds each file's identity, path and agreed hash. Building
 * the index from it costs nothing and is exactly the set reconcile must not
 * duplicate: the phone re-uploaded 31 notes it had just finished downloading.
 */

import { describe, expect, it } from 'vitest';

import { FileRegistry } from './file-registry';
import { serverIndexFromRegistry } from './registry-server-index';

const PATH_A = 'Notes/a.md';
const PATH_B = 'Notes/b.md';

function registryWith(
  files: ReadonlyArray<{ fileId: string; path: string; hash: string; content: string }>,
): FileRegistry {
  const registry = new FileRegistry();
  for (const file of files) {
    registry.agreedWithPeer({
      fileId: file.fileId,
      path: file.path,
      collisionKey: file.path.toLowerCase(),
      content: file.content,
      contentHash: file.hash,
      headRevisionId: `rev-${file.fileId}`,
    });
  }
  return registry;
}

describe('server index from the registry', () => {
  it('finds a file by the content the vault already holds', () => {
    const index = serverIndexFromRegistry(
      registryWith([
        { fileId: 'f1', path: PATH_A, hash: 'h1', content: 'one\n' },
      ]),
    );

    expect(index.byContentHash('h1')).toEqual({ fileId: 'f1', path: PATH_A });
  });

  it('finds a file by path', () => {
    const index = serverIndexFromRegistry(
      registryWith([
        { fileId: 'f1', path: PATH_A, hash: 'h1', content: 'one\n' },
      ]),
    );

    expect(index.byPath(PATH_A)).toEqual({ fileId: 'f1', hash: 'h1' });
  });

  it('reports nothing for content the vault does not hold', () => {
    const index = serverIndexFromRegistry(
      registryWith([
        { fileId: 'f1', path: PATH_A, hash: 'h1', content: 'one\n' },
      ]),
    );

    expect(index.byContentHash('h9')).toBeUndefined();
    expect(index.byPath('Notes/missing.md')).toBeUndefined();
  });

  it('indexes a first authorship, which the registry treats as agreed', () => {
    // First authorship seeds the agreed state (there is no older agreement to
    // protect and a file with no ancestor could never merge), so such a file IS
    // part of what this device would offer. Pinned because it is the one case
    // where "authored locally" and "agreed" coincide.
    const registry = new FileRegistry();
    registry.authoredLocally({
      fileId: 'f1',
      path: PATH_A,
      collisionKey: 'notes/a.md',
      content: 'draft\n',
      contentHash: 'h-draft',
      headRevisionId: 'rev-1',
    });

    const index = serverIndexFromRegistry(registry, { agreedOnly: true });

    expect(index.byContentHash('h-draft')?.fileId).toBe('f1');
  });

  it('skips a file whose agreed hash was cleared', () => {
    // A record left without an agreed hash carries no content the vault is
    // known to hold, so adopting against it would be a guess.
    const registry = new FileRegistry();
    registry.patch('f1', { path: PATH_A, collisionKey: 'notes/a.md' });

    const index = serverIndexFromRegistry(registry);

    expect(index.byPath(PATH_A)).toBeUndefined();
  });

  it('indexes every file a bootstrap materialised', () => {
    const index = serverIndexFromRegistry(
      registryWith([
        { fileId: 'f1', path: PATH_A, hash: 'h1', content: 'one\n' },
        { fileId: 'f2', path: PATH_B, hash: 'h2', content: 'two\n' },
      ]),
    );

    expect(index.byContentHash('h1')?.fileId).toBe('f1');
    expect(index.byContentHash('h2')?.fileId).toBe('f2');
  });

  it('keeps one entry per content when two files share it', () => {
    // Two vault files legitimately holding the same text: adoption must pick
    // one deterministically rather than depending on iteration order.
    const index = serverIndexFromRegistry(
      registryWith([
        { fileId: 'f2', path: PATH_B, hash: 'same', content: 'x\n' },
        { fileId: 'f1', path: PATH_A, hash: 'same', content: 'x\n' },
      ]),
    );

    // Lowest fileId wins, so two devices building the index agree.
    expect(index.byContentHash('same')?.fileId).toBe('f1');
  });
});

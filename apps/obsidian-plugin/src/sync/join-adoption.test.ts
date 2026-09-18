/**
 * A joining device adopts what the server already has, it does not re-upload it.
 *
 * When a second device joins a vault it usually holds a copy of the same notes
 * already: the user seeded it from the same source. Connect-time reconcile sees
 * those files, finds no local mapping for them, and pushes every one as a brand
 * new file. On the pilot vault that produced 117 files for 86 distinct contents:
 * each duplicated note now exists twice under two different identities, and
 * 5.4 MB went over the wire for content the server already had.
 *
 * Identity has to be settled by CONTENT at join time. If the server already
 * holds a file whose content hash matches what is on disk, the joining device
 * adopts that file's identity instead of minting its own.
 *
 * This is deliberately a join-time rule, not a general one: two files with the
 * same text at different paths are still two files during normal operation. It
 * applies only while reconciling a device against a vault it has just joined.
 */

import { describe, expect, it } from 'vitest';

import { adoptOrCreate, type ServerFileIndex } from './join-adoption';

const PATH_A = 'Notes/a.md';
const PATH_B = 'Notes/b.md';

/** What the server reports for a vault: content hash -> its file identity. */
function serverIndex(
  entries: ReadonlyArray<{ hash: string; fileId: string; path: string }>,
): ServerFileIndex {
  const byHash = new Map<string, { fileId: string; path: string }>();
  const byPath = new Map<string, { fileId: string; hash: string }>();
  for (const entry of entries) {
    byHash.set(entry.hash, { fileId: entry.fileId, path: entry.path });
    byPath.set(entry.path, { fileId: entry.fileId, hash: entry.hash });
  }
  return {
    byContentHash: (hash) => byHash.get(hash),
    byPath: (path) => byPath.get(path),
  };
}

describe('join-time adoption', () => {
  it('adopts the server identity when the content matches', () => {
    const index = serverIndex([
      { hash: 'h1', fileId: 'server-file-1', path: PATH_A },
    ]);

    const decision = adoptOrCreate(index, { path: PATH_A, contentHash: 'h1' });

    expect(decision).toEqual({ kind: 'adopt', fileId: 'server-file-1' });
  });

  it('adopts even when the path differs', () => {
    // The same note filed under another name on this device is still that note;
    // re-uploading it would fork the identity and duplicate the content.
    const index = serverIndex([
      { hash: 'h1', fileId: 'server-file-1', path: PATH_A },
    ]);

    const decision = adoptOrCreate(index, { path: PATH_B, contentHash: 'h1' });

    expect(decision).toEqual({ kind: 'adopt', fileId: 'server-file-1' });
  });

  it('creates when the server has nothing like it', () => {
    // A genuinely new note on the joining device must still reach the vault.
    const index = serverIndex([
      { hash: 'h1', fileId: 'server-file-1', path: PATH_A },
    ]);

    const decision = adoptOrCreate(index, { path: PATH_B, contentHash: 'h2' });

    expect(decision).toEqual({ kind: 'create' });
  });

  it('creates when the server vault is empty', () => {
    const decision = adoptOrCreate(serverIndex([]), {
      path: PATH_A,
      contentHash: 'h1',
    });
    expect(decision).toEqual({ kind: 'create' });
  });

  it('prefers the path match when content differs at the same path', () => {
    // Same path, different text: this is a real edit to a file the server owns,
    // so it belongs to that file's history rather than starting a new one.
    const index = serverIndex([
      { hash: 'h1', fileId: 'server-file-1', path: PATH_A },
    ]);

    const decision = adoptOrCreate(index, { path: PATH_A, contentHash: 'h2' });

    expect(decision).toEqual({
      kind: 'adopt-with-edit',
      fileId: 'server-file-1',
    });
  });

  it('adopts by content ahead of a same-path file with other content', () => {
    // The content match is the stronger signal: this exact text already has an
    // identity, and a path collision is a separate question.
    const index = serverIndex([
      { hash: 'h1', fileId: 'content-match', path: PATH_B },
      { hash: 'h9', fileId: 'path-match', path: PATH_A },
    ]);

    const decision = adoptOrCreate(index, { path: PATH_A, contentHash: 'h1' });

    expect(decision).toEqual({ kind: 'adopt', fileId: 'content-match' });
  });

  it('never adopts the same server file twice in one reconcile', () => {
    // Two local copies of one note must not both claim its identity, or the
    // second silently overwrites the first.
    const index = serverIndex([
      { hash: 'h1', fileId: 'server-file-1', path: PATH_A },
    ]);
    const claimed = new Set<string>();

    const first = adoptOrCreate(index, { path: PATH_A, contentHash: 'h1' }, claimed);
    const second = adoptOrCreate(index, { path: PATH_B, contentHash: 'h1' }, claimed);

    expect(first).toEqual({ kind: 'adopt', fileId: 'server-file-1' });
    expect(second).toEqual({ kind: 'create' });
  });
});

/**
 * Joining an empty vault is the case that actually bit.
 *
 * The connect sequence already pulls before the producer enumerates the vault,
 * but on a vault that is still EMPTY that pull returns instantly. The pilot hit
 * exactly this: the phone joined seconds after the desktop started uploading,
 * saw nothing on the server, and pushed its own copy of every note. Both
 * devices then held the same text under two identities.
 *
 * Waiting for the vault to settle is what makes the content check meaningful:
 * a decision taken against a half-filled index is the same mistake with extra
 * steps.
 */
describe('joining a vault that is still filling', () => {
  it('adopts once the server has caught up', () => {
    // Same local file, decided against the vault before and after the peer's
    // upload lands. Only the second decision can be right.
    const empty = serverIndex([]);
    const filled = serverIndex([
      { hash: 'h1', fileId: 'server-file-1', path: PATH_A },
    ]);
    const local = { path: PATH_A, contentHash: 'h1' };

    expect(adoptOrCreate(empty, local)).toEqual({ kind: 'create' });
    expect(adoptOrCreate(filled, local)).toEqual({
      kind: 'adopt',
      fileId: 'server-file-1',
    });
  });

  it('adopts every file the peer uploaded, not just the first', () => {
    const filled = serverIndex([
      { hash: 'h1', fileId: 'f1', path: 'Notes/1.md' },
      { hash: 'h2', fileId: 'f2', path: 'Notes/2.md' },
      { hash: 'h3', fileId: 'f3', path: 'Notes/3.md' },
    ]);
    const claimed = new Set<string>();

    const decisions = [
      adoptOrCreate(filled, { path: 'Notes/1.md', contentHash: 'h1' }, claimed),
      adoptOrCreate(filled, { path: 'Notes/2.md', contentHash: 'h2' }, claimed),
      adoptOrCreate(filled, { path: 'Notes/3.md', contentHash: 'h3' }, claimed),
    ];

    expect(decisions).toEqual([
      { kind: 'adopt', fileId: 'f1' },
      { kind: 'adopt', fileId: 'f2' },
      { kind: 'adopt', fileId: 'f3' },
    ]);
  });

  it('still uploads what is genuinely only on this device', () => {
    // The phone's own notes must reach the vault; adoption is not suppression.
    const filled = serverIndex([
      { hash: 'h1', fileId: 'f1', path: 'Notes/shared.md' },
    ]);
    const claimed = new Set<string>();

    expect(
      adoptOrCreate(filled, { path: 'Notes/shared.md', contentHash: 'h1' }, claimed),
    ).toEqual({ kind: 'adopt', fileId: 'f1' });
    expect(
      adoptOrCreate(filled, { path: 'Notes/phone-only.md', contentHash: 'h9' }, claimed),
    ).toEqual({ kind: 'create' });
  });
});

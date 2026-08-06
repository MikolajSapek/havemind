import { describe, expect, it } from 'vitest';

import { resolvePathOwnership, type PathClaim } from './path-ownership.js';

function claim(overrides: Partial<PathClaim> = {}): PathClaim {
  return {
    fileId: 'file-a',
    revisionId: 'revision-a',
    path: 'Notes/Plan.md',
    serverSequence: 1,
    ...overrides,
  };
}

describe('resolvePathOwnership', () => {
  it('materializes one uncontested canonical path', () => {
    expect(resolvePathOwnership([claim()])).toEqual({
      conflicts: [],
      winners: [claim()],
    });
  });

  it('detects Unicode and case collisions between different files', () => {
    const first = claim({
      fileId: 'file-a',
      revisionId: 'revision-a',
      path: 'Notes/Café.md',
      serverSequence: 20,
    });
    const earlier = claim({
      fileId: 'file-b',
      revisionId: 'revision-b',
      path: 'notes/Café.md',
      serverSequence: 10,
    });

    const result = resolvePathOwnership([first, earlier]);

    expect(result.winners).toEqual([
      { ...earlier, path: 'notes/Café.md' },
    ]);
    expect(result.conflicts).toEqual([
      {
        collisionKey: 'notes/café.md',
        contenders: [
          { ...earlier, path: 'notes/Café.md' },
          first,
        ],
        winner: { ...earlier, path: 'notes/Café.md' },
      },
    ]);
  });

  it('uses revision and file IDs as deterministic sequence tie-breakers', () => {
    const result = resolvePathOwnership([
      claim({ fileId: 'file-z', revisionId: 'revision-z', serverSequence: 4 }),
      claim({ fileId: 'file-a', revisionId: 'revision-a', serverSequence: 4 }),
    ]);

    expect(result.winners[0]?.fileId).toBe('file-a');
  });

  it('does not create a cross-file conflict for duplicate heads of one file', () => {
    const result = resolvePathOwnership([
      claim({ revisionId: 'revision-b', serverSequence: 2 }),
      claim({ revisionId: 'revision-a', serverSequence: 1 }),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.winners).toEqual([
      claim({ revisionId: 'revision-a', serverSequence: 1 }),
    ]);
  });

  it('rejects reserved paths and invalid server sequences', () => {
    expect(() =>
      // Denylisted under the `.obsidian/` mirror (per-machine layout) — stays
      // reserved even though most `.obsidian/` config now syncs.
      resolvePathOwnership([claim({ path: '.obsidian/workspace.json' })]),
    ).toThrow(/reserved/i);
    expect(() =>
      resolvePathOwnership([claim({ serverSequence: 0 })]),
    ).toThrow(/sequence/i);
  });

  it('rejects empty file or revision identifiers', () => {
    expect(() =>
      resolvePathOwnership([claim({ fileId: '   ' })]),
    ).toThrow(/file and revision/i);
    expect(() =>
      resolvePathOwnership([claim({ revisionId: '' })]),
    ).toThrow(/file and revision/i);
  });

  it('breaks sequence and revision ties on file ID', () => {
    const result = resolvePathOwnership([
      claim({ fileId: 'file-z', revisionId: 'revision-a', serverSequence: 7 }),
      claim({ fileId: 'file-a', revisionId: 'revision-a', serverSequence: 7 }),
    ]);

    expect(result.winners[0]?.fileId).toBe('file-a');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.contenders.map((c) => c.fileId)).toEqual([
      'file-a',
      'file-z',
    ]);
  });

  it('orders identical-key single-file claims by canonical path', () => {
    const result = resolvePathOwnership([
      claim({ path: 'notes/plan.md', serverSequence: 5 }),
      claim({ path: 'Notes/Plan.md', serverSequence: 5 }),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.winners[0]?.path).toBe('Notes/Plan.md');
  });

  it('emits winners across multiple collision groups in key order', () => {
    const result = resolvePathOwnership([
      claim({ fileId: 'file-y', path: 'Notes/Zeta.md', serverSequence: 3 }),
      claim({ fileId: 'file-x', path: 'Notes/Alpha.md', serverSequence: 2 }),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.winners.map((winner) => winner.path)).toEqual([
      'Notes/Alpha.md',
      'Notes/Zeta.md',
    ]);
  });
});

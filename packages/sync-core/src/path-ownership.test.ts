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
      resolvePathOwnership([claim({ path: '.obsidian/plugins/data.md' })]),
    ).toThrow(/reserved/i);
    expect(() =>
      resolvePathOwnership([claim({ serverSequence: 0 })]),
    ).toThrow(/sequence/i);
  });
});

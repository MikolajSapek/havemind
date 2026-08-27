import { describe, expect, it, vi } from 'vitest';

import {
  CONFLICT_FOLDER,
  computeLineDiff,
  createConflictResolver,
  createObsidianConflictPort,
  listConflictCopies,
  parseConflictCopyName,
  type ConflictVaultFile,
  type ConflictVaultPort,
} from './conflict-resolution';

/** A recording fake of the vault port, no Obsidian, fully headless. */
function fakePort(
  overrides: Partial<{
    conflictFiles: ConflictVaultFile[];
    noteFiles: ConflictVaultFile[];
    contents: Record<string, string>;
    /** Paths that report as present via `exists`. Defaults to the content keys. */
    existingPaths: string[];
    /**
     * Paths whose `readText` returns null (absent) even though `exists` may
     * report present, models the exists→read TOCTOU (MINOR 6).
     */
    nullReads: string[];
  }> = {},
): ConflictVaultPort & {
  reads: string[];
  writes: Array<{ path: string; content: string }>;
  deletes: string[];
} {
  const contents = overrides.contents ?? {};
  const present = new Set(overrides.existingPaths ?? Object.keys(contents));
  const nullReads = new Set(overrides.nullReads ?? []);
  const reads: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const deletes: string[] = [];
  return {
    reads,
    writes,
    deletes,
    listConflictFiles: () => overrides.conflictFiles ?? [],
    listNoteFiles: () => overrides.noteFiles ?? [],
    exists: async (path: string) => present.has(path),
    readText: async (path: string) => {
      reads.push(path);
      if (nullReads.has(path)) return null;
      return contents[path] ?? '';
    },
    writeText: async (path: string, content: string) => {
      writes.push({ path, content });
    },
    deleteFile: async (path: string) => {
      deletes.push(path);
    },
  };
}

describe('parseConflictCopyName', () => {
  it('parses a new-format markdown copy with spaces and Polish diacritics', () => {
    const parsed = parseConflictCopyName(
      'Spotkanie zespołu (conflict Zażółć Gęślą 2026-07-16 1542).md',
    );
    expect(parsed).toEqual({
      kind: 'new',
      extension: 'md',
      isBinary: false,
      noteBasename: 'Spotkanie zespołu',
      author: 'Zażółć Gęślą',
      timestamp: '2026-07-16 1542',
    });
  });

  it('parses a new-format binary copy keeping its extension', () => {
    const parsed = parseConflictCopyName(
      'diagram (conflict Magda 2026-07-16 1542).png',
    );
    expect(parsed?.kind).toBe('new');
    expect(parsed?.extension).toBe('png');
    expect(parsed?.isBinary).toBe(true);
    expect(parsed?.noteBasename).toBe('diagram');
  });

  it('parses a legacy uuid-uuid name with no derivable target', () => {
    const parsed = parseConflictCopyName(
      'd1e2f3a4-b5c6-4d7e-8f90-1a2b3c4d5e6f-a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.md',
    );
    expect(parsed?.kind).toBe('legacy');
    expect(parsed?.noteBasename).toBeNull();
    expect(parsed?.author).toBeNull();
  });

  it('returns null for a name that is not a conflict copy', () => {
    expect(parseConflictCopyName('just a normal note.md')).toBeNull();
  });
});

describe('listConflictCopies', () => {
  it('is empty when the reserved folder has no copies', () => {
    expect(listConflictCopies(fakePort())).toEqual([]);
  });

  it('pairs a new-format copy to a unique target note at any path', () => {
    const copies = listConflictCopies(
      fakePort({
        conflictFiles: [
          {
            path: `${CONFLICT_FOLDER}/Notatka (conflict Magda 2026-07-16 1542).md`,
            name: 'Notatka (conflict Magda 2026-07-16 1542).md',
          },
        ],
        noteFiles: [{ path: 'projects/deep/Notatka.md', name: 'Notatka.md' }],
      }),
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]?.targetKnown).toBe(true);
    expect(copies[0]?.targetPath).toBe('projects/deep/Notatka.md');
    expect(copies[0]?.author).toBe('Magda');
    expect(copies[0]?.manualHint).toBeNull();
  });

  it('flags ambiguity (>1 candidate) with a manual hint and no target', () => {
    const copies = listConflictCopies(
      fakePort({
        conflictFiles: [
          {
            path: `${CONFLICT_FOLDER}/Notatka (conflict Magda 2026-07-16 1542).md`,
            name: 'Notatka (conflict Magda 2026-07-16 1542).md',
          },
        ],
        noteFiles: [
          { path: 'a/Notatka.md', name: 'Notatka.md' },
          { path: 'b/Notatka.md', name: 'Notatka.md' },
        ],
      }),
    );
    expect(copies[0]?.targetKnown).toBe(false);
    expect(copies[0]?.targetPath).toBeNull();
    expect(copies[0]?.manualHint).not.toBeNull();
  });

  it('flags a missing target (0 candidates) with a manual hint', () => {
    const copies = listConflictCopies(
      fakePort({
        conflictFiles: [
          {
            path: `${CONFLICT_FOLDER}/Gone (conflict Magda 2026-07-16 1542).md`,
            name: 'Gone (conflict Magda 2026-07-16 1542).md',
          },
        ],
        noteFiles: [],
      }),
    );
    expect(copies[0]?.targetKnown).toBe(false);
    expect(copies[0]?.manualHint).not.toBeNull();
  });

  it('lists legacy uuid copies with a manual hint and no derivable target', () => {
    const name =
      'd1e2f3a4-b5c6-4d7e-8f90-1a2b3c4d5e6f-a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.md';
    const copies = listConflictCopies(
      fakePort({
        conflictFiles: [{ path: `${CONFLICT_FOLDER}/${name}`, name }],
        noteFiles: [],
      }),
    );
    expect(copies[0]?.kind).toBe('legacy');
    expect(copies[0]?.targetKnown).toBe(false);
    expect(copies[0]?.noteName).toBeNull();
    expect(copies[0]?.manualHint).not.toBeNull();
  });
});

describe('computeLineDiff', () => {
  it('marks added, removed and context lines with a stable shape', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nx\nc');
    expect(diff).toEqual([
      { type: 'context', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'added', text: 'x' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('normalises CRLF so Windows copies do not diff as fully changed', () => {
    const diff = computeLineDiff('a\r\nb', 'a\nb');
    expect(diff.every((line) => line.type === 'context')).toBe(true);
  });
});

describe('createConflictResolver', () => {
  const newCopy = {
    copyPath: `${CONFLICT_FOLDER}/Notatka (conflict Magda 2026-07-16 1542).md`,
    copyName: 'Notatka (conflict Magda 2026-07-16 1542).md',
    kind: 'new' as const,
    noteName: 'Notatka',
    author: 'Magda',
    timestamp: '2026-07-16 1542',
    isBinary: false,
    targetPath: 'Notatka.md',
    targetKnown: true,
    manualHint: null,
  };

  it('keepMine deletes the copy exactly once even on a double click', async () => {
    const port = fakePort();
    const del = vi.spyOn(port, 'deleteFile');
    const resolver = createConflictResolver(port);

    const [a, b] = await Promise.all([
      resolver.resolve(newCopy, 'keepMine'),
      resolver.resolve(newCopy, 'keepMine'),
    ]);

    expect([a, b].sort()).toEqual(['ignored', 'resolved']);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(newCopy.copyPath);
  });

  it('keepTheirs writes the copy into the note then deletes the copy', async () => {
    const port = fakePort({ contents: { [newCopy.copyPath]: 'theirs body' } });
    const resolver = createConflictResolver(port);

    const result = await resolver.resolve(newCopy, 'keepTheirs');

    expect(result).toBe('resolved');
    expect(port.reads).toEqual([newCopy.copyPath]);
    expect(port.writes).toEqual([
      { path: 'Notatka.md', content: 'theirs body' },
    ]);
    expect(port.deletes).toEqual([newCopy.copyPath]);
  });

  it('keepBoth touches no files', async () => {
    const port = fakePort();
    const resolver = createConflictResolver(port);

    const result = await resolver.resolve(newCopy, 'keepBoth');

    expect(result).toBe('resolved');
    expect(port.deletes).toEqual([]);
    expect(port.writes).toEqual([]);
  });

  it('keepTheirs aborts as "vanished" when the sweep already deleted the copy, never blanks the note', async () => {
    // The copy is gone (the auto-sweep resolved and deleted it): `exists`
    // reports absent, so keepTheirs must NOT read '' and overwrite the good,
    // merged live note with an empty string (the data-loss bug).
    const port = fakePort({ existingPaths: [] });
    const resolver = createConflictResolver(port);

    const result = await resolver.resolve(newCopy, 'keepTheirs');

    expect(result).toBe('vanished');
    expect(port.writes).toEqual([]);
    expect(port.deletes).toEqual([]);
  });

  it('keepTheirs aborts as "vanished" when the read finds the copy absent despite exists passing (MINOR 6 TOCTOU)', async () => {
    // The exists() check passes but the copy is deleted before readText runs.
    // readText now signals absence as null (not ''), so keepTheirs aborts
    // rather than blanking the live note with an empty overwrite.
    const port = fakePort({
      existingPaths: [newCopy.copyPath],
      nullReads: [newCopy.copyPath],
    });
    const resolver = createConflictResolver(port);

    const result = await resolver.resolve(newCopy, 'keepTheirs');

    expect(result).toBe('vanished');
    expect(port.writes).toEqual([]);
    expect(port.deletes).toEqual([]);
  });

  it('keepMine on a vanished copy is a graceful no-op (still resolved)', async () => {
    const port = fakePort({ existingPaths: [] });
    const resolver = createConflictResolver(port);

    const result = await resolver.resolve(newCopy, 'keepMine');

    expect(result).toBe('resolved');
    expect(port.writes).toEqual([]);
  });

  it('keepTheirs writes a verifiably-empty copy that still exists', async () => {
    // A genuinely empty copy (present on disk, empty content) is a legitimate
    // "make the note empty", it must still apply because the copy exists.
    const port = fakePort({
      contents: { [newCopy.copyPath]: '' },
      existingPaths: [newCopy.copyPath],
    });
    const resolver = createConflictResolver(port);

    const result = await resolver.resolve(newCopy, 'keepTheirs');

    expect(result).toBe('resolved');
    expect(port.writes).toEqual([{ path: 'Notatka.md', content: '' }]);
    expect(port.deletes).toEqual([newCopy.copyPath]);
  });
});

describe('createObsidianConflictPort', () => {
  interface FakeFile {
    path: string;
    name: string;
  }

  function fakeVault(files: FakeFile[]): {
    vault: Parameters<typeof createObsidianConflictPort>[0];
    modified: Array<{ path: string; content: string }>;
    deleted: string[];
  } {
    const modified: Array<{ path: string; content: string }> = [];
    const deleted: string[] = [];
    const byPath = new Map(files.map((file) => [file.path, file]));
    const vault = {
      getFiles: () => files,
      getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
      read: async (file: FakeFile) => `body of ${file.path}`,
      modify: async (file: FakeFile, content: string) => {
        modified.push({ path: file.path, content });
      },
      delete: async (file: FakeFile) => {
        deleted.push(file.path);
      },
    } as unknown as Parameters<typeof createObsidianConflictPort>[0];
    return { vault, modified, deleted };
  }

  it('splits vault files into conflict copies and candidate notes', () => {
    const { vault } = fakeVault([
      {
        path: `${CONFLICT_FOLDER}/N (conflict Magda 2026-07-16 1542).md`,
        name: 'N (conflict Magda 2026-07-16 1542).md',
      },
      { path: 'deep/N.md', name: 'N.md' },
    ]);
    const port = createObsidianConflictPort(vault);
    expect(port.listConflictFiles().map((f) => f.name)).toEqual([
      'N (conflict Magda 2026-07-16 1542).md',
    ]);
    expect(port.listNoteFiles().map((f) => f.path)).toEqual(['deep/N.md']);
  });

  it('writes and deletes through the vault API', async () => {
    const { vault, modified, deleted } = fakeVault([
      { path: 'N.md', name: 'N.md' },
      { path: `${CONFLICT_FOLDER}/c.md`, name: 'c.md' },
    ]);
    const port = createObsidianConflictPort(vault);
    await port.writeText('N.md', 'new body');
    await port.deleteFile(`${CONFLICT_FOLDER}/c.md`);
    expect(modified).toEqual([{ path: 'N.md', content: 'new body' }]);
    expect(deleted).toEqual([`${CONFLICT_FOLDER}/c.md`]);
  });

  it('degrades to no conflicts when the vault lacks getFiles', () => {
    const port = createObsidianConflictPort(
      {} as unknown as Parameters<typeof createObsidianConflictPort>[0],
    );
    expect(port.listConflictFiles()).toEqual([]);
    expect(port.listNoteFiles()).toEqual([]);
  });
});

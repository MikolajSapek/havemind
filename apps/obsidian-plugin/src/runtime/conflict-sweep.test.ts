import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sweepConflictCopies, type ThreeWayMerge } from './conflict-sweep';
import {
  CONFLICT_FOLDER,
  type ConflictVaultFile,
  type ConflictVaultPort,
} from './conflict-resolution';

/**
 * In-memory vault backing the sweep: a flat path→content map partitioned into
 * "reserved folder" (conflict copies) and everything else (target notes) exactly
 * as `createObsidianConflictPort` does. Records deletes so tests can assert a
 * copy was (or was not) removed.
 */
class FakeConflictVault implements ConflictVaultPort {
  private readonly files = new Map<string, string>();
  readonly deleted: string[] = [];

  put(path: string, content: string): void {
    this.files.set(path, content);
  }

  private list(inside: boolean): ConflictVaultFile[] {
    const result: ConflictVaultFile[] = [];
    for (const path of this.files.keys()) {
      const reserved =
        path === CONFLICT_FOLDER || path.startsWith(`${CONFLICT_FOLDER}/`);
      if (reserved !== inside) continue;
      const slash = path.lastIndexOf('/');
      result.push({ path, name: slash === -1 ? path : path.slice(slash + 1) });
    }
    return result;
  }

  listConflictFiles(): ConflictVaultFile[] {
    return this.list(true);
  }

  listNoteFiles(): ConflictVaultFile[] {
    return this.list(false);
  }

  async readText(path: string): Promise<string> {
    return this.files.get(path) ?? '';
  }

  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    if (!this.files.has(path)) throw new Error(`missing: ${path}`);
    this.files.delete(path);
    this.deleted.push(path);
  }

  read(path: string): string | undefined {
    return this.files.get(path);
  }

  has(path: string): boolean {
    return this.files.has(path);
  }
}

const NOTE = 'Notatka.md';
const COPY = `${CONFLICT_FOLDER}/Notatka (conflict Magda 2026-07-16 1542).md`;
const ANCESTOR = 'A\nB\nC\n';

/**
 * Base deps: the target note is owned by `file-1`, whose hash-verified base
 * content is the common ancestor. `hashContent` is the identity function so a
 * base whose "hash" equals the ancestor text verifies cleanly.
 */
function baseDeps(vault: FakeConflictVault, overrides: Partial<Parameters<typeof sweepConflictCopies>[0]> = {}) {
  return {
    port: vault,
    fileIdAtPath: (path: string) => (path === NOTE ? 'file-1' : null),
    baseContentFor: (fileId: string) => (fileId === 'file-1' ? ANCESTOR : null),
    baseHashFor: (fileId: string) => (fileId === 'file-1' ? ANCESTOR : null),
    hashContent: async (content: string) => content,
    notify: vi.fn(),
    ...overrides,
  };
}

describe('sweepConflictCopies', () => {
  let vault: FakeConflictVault;

  beforeEach(() => {
    vault = new FakeConflictVault();
    vault.put(NOTE, ANCESTOR);
    vault.put(COPY, ANCESTOR);
  });

  it('auto-resolves a mergeable copy: note updated, copy deleted, one Notice', async () => {
    // Non-overlapping edits: the note added a line at the top, the copy at the
    // bottom — a clean three-way merge combines both.
    vault.put(NOTE, 'top\nA\nB\nC\n');
    vault.put(COPY, 'A\nB\nC\nbottom\n');
    const deps = baseDeps(vault);

    const resolved = await sweepConflictCopies(deps);

    expect(resolved).toBe(1);
    expect(vault.read(NOTE)).toBe('top\nA\nB\nC\nbottom\n');
    expect(vault.has(COPY)).toBe(false);
    expect(vault.deleted).toEqual([COPY]);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith('Auto-resolved 1 conflict(s)');
  });

  it('skips an overlapping merge: note untouched, copy kept, no Notice', async () => {
    vault.put(NOTE, 'A\nMINE\nC\n');
    vault.put(COPY, 'A\nTHEIRS\nC\n');
    const deps = baseDeps(vault);

    const resolved = await sweepConflictCopies(deps);

    expect(resolved).toBe(0);
    expect(vault.read(NOTE)).toBe('A\nMINE\nC\n');
    expect(vault.has(COPY)).toBe(true);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('skips a binary copy (never merged, never deleted)', async () => {
    const binaryCopy = `${CONFLICT_FOLDER}/Photo (conflict Magda 2026-07-16 1542).png`;
    vault.put(binaryCopy, 'bytes');
    vault.put('Photo.png', 'bytes');
    const deps = baseDeps(vault, {
      fileIdAtPath: () => 'file-1',
    });
    // Only the markdown copy resolves; the binary one is left in place.
    vault.put(NOTE, 'top\nA\nB\nC\n');
    vault.put(COPY, 'A\nB\nC\nbottom\n');

    const resolved = await sweepConflictCopies(deps);

    expect(resolved).toBe(1);
    expect(vault.has(binaryCopy)).toBe(true);
  });

  it('skips a legacy UUID-named copy', async () => {
    const legacy = `${CONFLICT_FOLDER}/11111111-1111-1111-1111-111111111111-22222222-2222-2222-2222-222222222222.md`;
    vault = new FakeConflictVault();
    vault.put(legacy, 'anything');
    const deps = baseDeps(vault);

    const resolved = await sweepConflictCopies(deps);

    expect(resolved).toBe(0);
    expect(vault.has(legacy)).toBe(true);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('skips when no ancestor is recorded (never guesses)', async () => {
    vault.put(NOTE, 'top\nA\nB\nC\n');
    vault.put(COPY, 'A\nB\nC\nbottom\n');
    const deps = baseDeps(vault, { baseContentFor: () => null });

    const resolved = await sweepConflictCopies(deps);

    expect(resolved).toBe(0);
    expect(vault.has(COPY)).toBe(true);
  });

  it('skips when the stored ancestor no longer matches the base hash', async () => {
    vault.put(NOTE, 'top\nA\nB\nC\n');
    vault.put(COPY, 'A\nB\nC\nbottom\n');
    const deps = baseDeps(vault, { baseHashFor: () => 'a-different-hash' });

    const resolved = await sweepConflictCopies(deps);

    expect(resolved).toBe(0);
    expect(vault.has(COPY)).toBe(true);
  });

  it('skips when the target note has no owning fileId', async () => {
    vault.put(NOTE, 'top\nA\nB\nC\n');
    vault.put(COPY, 'A\nB\nC\nbottom\n');
    const deps = baseDeps(vault, { fileIdAtPath: () => null });

    const resolved = await sweepConflictCopies(deps);

    expect(resolved).toBe(0);
    expect(vault.has(COPY)).toBe(true);
  });

  it('isolates a failing copy and still resolves the healthy one', async () => {
    // Two mergeable copies; the first throws on delete, the second succeeds.
    const copyA = `${CONFLICT_FOLDER}/Alpha (conflict Magda 2026-07-16 1542).md`;
    const copyB = `${CONFLICT_FOLDER}/Beta (conflict Magda 2026-07-16 1542).md`;
    vault = new FakeConflictVault();
    vault.put('Alpha.md', 'top\nA\nB\nC\n');
    vault.put('Beta.md', 'top\nA\nB\nC\n');
    vault.put(copyA, 'A\nB\nC\nbottom\n');
    vault.put(copyB, 'A\nB\nC\nbottom\n');
    const deps = baseDeps(vault, {
      fileIdAtPath: (path: string) =>
        path === 'Alpha.md' || path === 'Beta.md' ? 'file-1' : null,
    });
    const realDelete = vault.deleteFile.bind(vault);
    vi.spyOn(vault, 'deleteFile').mockImplementation(async (path: string) => {
      if (path === copyA) throw new Error('boom');
      await realDelete(path);
    });

    const resolved = await sweepConflictCopies(deps);

    expect(resolved).toBe(1);
    expect(vault.has(copyB)).toBe(false);
    expect(vault.has(copyA)).toBe(true);
    expect(deps.notify).toHaveBeenCalledWith('Auto-resolved 1 conflict(s)');
  });

  it('is idempotent: a second sweep with nothing resolvable is silent', async () => {
    vault.put(NOTE, 'top\nA\nB\nC\n');
    vault.put(COPY, 'A\nB\nC\nbottom\n');
    const deps = baseDeps(vault);

    await sweepConflictCopies(deps);
    (deps.notify as ReturnType<typeof vi.fn>).mockClear();

    const second = await sweepConflictCopies(deps);
    expect(second).toBe(0);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(vault.deleted).toEqual([COPY]);
  });

  it('emits a single summarising Notice for multiple resolved copies', async () => {
    const copyA = `${CONFLICT_FOLDER}/Alpha (conflict Magda 2026-07-16 1542).md`;
    const copyB = `${CONFLICT_FOLDER}/Beta (conflict Magda 2026-07-16 1542).md`;
    vault = new FakeConflictVault();
    vault.put('Alpha.md', 'top\nA\nB\nC\n');
    vault.put('Beta.md', 'top\nA\nB\nC\n');
    vault.put(copyA, 'A\nB\nC\nbottom\n');
    vault.put(copyB, 'A\nB\nC\nbottom\n');
    const deps = baseDeps(vault, {
      fileIdAtPath: (path: string) =>
        path === 'Alpha.md' || path === 'Beta.md' ? 'file-1' : null,
    });

    const resolved = await sweepConflictCopies(deps);

    expect(resolved).toBe(2);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith('Auto-resolved 2 conflict(s)');
  });

  it('accepts an injected merge (proves the wired default is replaceable)', async () => {
    vault.put(NOTE, 'top\nA\nB\nC\n');
    vault.put(COPY, 'A\nB\nC\nbottom\n');
    const merge: ThreeWayMerge = () => ({ status: 'conflict' });
    const deps = baseDeps(vault, { merge });

    const resolved = await sweepConflictCopies(deps);

    expect(resolved).toBe(0);
    expect(vault.has(COPY)).toBe(true);
  });
});

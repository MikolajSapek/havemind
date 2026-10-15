import { describe, expect, it } from 'vitest';

import { createVaultFilePort } from './vault-file-port';

interface FakeEntry {
  path: string;
  name: string;
  children?: FakeEntry[];
}

/** Minimal Vault double: files and folders keyed by path, children kept per folder. */
class FakeVault {
  readonly texts = new Map<string, string>();
  readonly bytes = new Map<string, ArrayBuffer>();
  readonly modified: string[] = [];
  private readonly entries = new Map<string, FakeEntry>([['', { path: '', name: '', children: [] }]]);

  private add(path: string, folder: boolean): FakeEntry {
    const slash = path.lastIndexOf('/');
    const entry: FakeEntry = { path, name: path.slice(slash + 1), ...(folder ? { children: [] } : {}) };
    this.entries.set(path, entry);
    this.entries.get(slash === -1 ? '' : path.slice(0, slash))?.children?.push(entry);
    return entry;
  }

  seed(path: string, text: string): void {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const folder = parts.slice(0, i).join('/');
      if (!this.entries.has(folder)) this.add(folder, true);
    }
    this.add(path, false);
    this.texts.set(path, text);
  }

  getAbstractFileByPath(path: string): FakeEntry | null {
    return path === '' ? null : this.entries.get(path) ?? null;
  }
  getFolderByPath(path: string): FakeEntry | null {
    const entry = this.entries.get(path);
    return entry?.children === undefined ? null : entry;
  }
  getRoot(): FakeEntry {
    return this.entries.get('') as FakeEntry;
  }
  async createFolder(path: string): Promise<void> {
    this.add(path, true);
  }
  async create(path: string, text: string): Promise<void> {
    if (this.entries.has(path)) throw new Error(`already exists: ${path}`);
    this.seed(path, text);
  }
  async createBinary(path: string, data: ArrayBuffer): Promise<void> {
    if (this.entries.has(path)) throw new Error(`already exists: ${path}`);
    this.seed(path, '');
    this.bytes.set(path, data);
  }
  async read(file: FakeEntry): Promise<string> {
    return this.texts.get(file.path) ?? '';
  }
  async readBinary(file: FakeEntry): Promise<ArrayBuffer> {
    return this.bytes.get(file.path) ?? new ArrayBuffer(0);
  }
  async modify(file: FakeEntry, text: string): Promise<void> {
    this.modified.push(file.path);
    this.texts.set(file.path, text);
  }
  async modifyBinary(file: FakeEntry, data: ArrayBuffer): Promise<void> {
    this.modified.push(file.path);
    this.bytes.set(file.path, data);
  }
}

function portOver(vault: FakeVault) {
  return createVaultFilePort({ vault: vault as never, state: {} as never });
}

const COPY = 'Havemind Conflicts/a (conflict Windows 2026-07-22 2156).md';
const COPY_2 = 'Havemind Conflicts/a 2 (conflict Windows 2026-07-22 2156).md';

describe('writeConflictArtifact on redelivery (plan 018, item 4)', () => {
  it('leaves an identical existing copy alone', async () => {
    const vault = new FakeVault();
    vault.seed(COPY, 'theirs\n');
    await portOver(vault).writeConflictArtifact(COPY, 'theirs\n');
    expect(vault.modified).toEqual([]);
  });

  it('never overwrites a copy the user edited: the revision lands under a new numbered name', async () => {
    const vault = new FakeVault();
    vault.seed(COPY, 'theirs, then edited by the user\n');

    await portOver(vault).writeConflictArtifact(COPY, 'theirs\n');

    expect(vault.modified).toEqual([]);
    expect(vault.texts.get(COPY)).toBe('theirs, then edited by the user\n');
    expect(vault.texts.get(COPY_2)).toBe('theirs\n');
  });

  it('finds its own earlier numbered copy again instead of piling up more', async () => {
    const vault = new FakeVault();
    vault.seed(COPY, 'edited\n');
    const port = portOver(vault);

    await port.writeConflictArtifact(COPY, 'theirs\n');
    await port.writeConflictArtifact(COPY, 'theirs\n');

    expect([...vault.texts.keys()].filter((p) => p.startsWith('Havemind Conflicts/')).sort()).toEqual([COPY, COPY_2]);
  });

  it('applies the same rule to an attachment copy', async () => {
    const vault = new FakeVault();
    const png = 'Havemind Conflicts/pic (conflict Windows 2026-07-22 2156).png';
    vault.seed(png, '');
    vault.bytes.set(png, new Uint8Array([9, 9]).buffer);

    await portOver(vault).writeBinaryConflictArtifact(png, new Uint8Array([1, 2]));

    expect(vault.modified).toEqual([]);
    const second = 'Havemind Conflicts/pic 2 (conflict Windows 2026-07-22 2156).png';
    expect(new Uint8Array(vault.bytes.get(second) as ArrayBuffer)).toEqual(new Uint8Array([1, 2]));
  });
});

describe('pathCaseVariant (plan 018, item 6)', () => {
  it('finds a sibling that differs only by letter case', async () => {
    const vault = new FakeVault();
    vault.seed('Notes/note.md', 'x');
    const port = portOver(vault);
    expect(await port.pathCaseVariant?.('Notes/Note.md')).toBe('Notes/note.md');
    expect(await port.pathCaseVariant?.('Notes/note.md')).toBeNull();
    expect(await port.pathCaseVariant?.('Notes/other.md')).toBeNull();
  });

  it('looks at the vault root for a top-level path', async () => {
    const vault = new FakeVault();
    vault.seed('note.md', 'x');
    expect(await portOver(vault).pathCaseVariant?.('NOTE.md')).toBe('note.md');
  });

  it('is null when the parent folder does not exist yet', async () => {
    expect(await portOver(new FakeVault()).pathCaseVariant?.('New/Note.md')).toBeNull();
  });
});

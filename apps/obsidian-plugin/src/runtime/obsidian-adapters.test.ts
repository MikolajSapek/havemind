import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'obsidian';

// Obsidian's real `requestUrl()` resolves to `{ status, headers, arrayBuffer,
// json, text }` (see obsidian.d.ts). The shared test mock re-exports the
// platform surface used by lifecycle tests but has no reason to model
// `requestUrl` itself, so this suite stubs it directly on top of the mocked
// module to exercise `createRequestUrlFn`'s real wrapping shape.
const mockRequestUrl = vi.fn();

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    requestUrl: mockRequestUrl,
  };
});

/**
 * Minimal stand-in for Obsidian's `TFile`/`TFolder` shape: just enough for
 * `instanceof` checks and a `path` field. This suite cannot statically
 * `import { TFile, TFolder } from 'obsidian'` because the module is
 * `vi.mock`-ed above with a factory that reads the hoisted `mockRequestUrl`
 * variable; a static import of the mocked module would itself be hoisted
 * ahead of that variable's initialization. Each test instead resolves the
 * real mock classes via a dynamic `import('obsidian')`, matching how this
 * file already dynamically imports `./obsidian-adapters`.
 */
type AbstractFileLike = { path: string };

/**
 * Minimal in-memory Vault double for `createVaultFilePort`'s
 * `writeConflictArtifact`. Distinguishes files from folders so it can model
 * the regression scenario: a FILE (no extension) occupying the exact
 * reserved conflict-folder path.
 */
class FakeVault {
  private readonly entries = new Map<
    string,
    { kind: 'file' | 'folder'; content?: string; binaryContent?: ArrayBuffer }
  >();

  constructor(
    private readonly TFileClass: new () => AbstractFileLike,
    private readonly TFolderClass: new () => AbstractFileLike,
  ) {}

  seedFile(path: string, content = ''): void {
    this.entries.set(path, { kind: 'file', content });
  }

  seedFolder(path: string): void {
    this.entries.set(path, { kind: 'folder' });
  }

  seedBinaryFile(path: string, data: ArrayBuffer): void {
    this.entries.set(path, { kind: 'file', binaryContent: data });
  }

  /**
   * FIDELITY: real Obsidian's `vault.create`/`createBinary`/`createFolder` THROW
   * when the immediate parent folder does not exist (it is not auto-created).
   * The old double silently accepted nested paths, which is exactly why 931
   * tests never caught the 5-day field outage — the missing-parent-folder throw
   * could not be reproduced. Model the throw so the RED test can exist.
   */
  private assertParentFolderExists(path: string): void {
    const separatorIndex = path.lastIndexOf('/');
    if (separatorIndex === -1) return;
    const parent = path.slice(0, separatorIndex);
    if (this.entries.get(parent)?.kind !== 'folder') {
      throw new Error(`Folder does not exist: ${parent}`);
    }
  }

  getAbstractFileByPath(path: string): AbstractFileLike | null {
    const entry = this.entries.get(path);
    if (entry === undefined) return null;
    if (entry.kind === 'folder') {
      const folder = new this.TFolderClass();
      folder.path = path;
      return folder;
    }
    const file = new this.TFileClass();
    file.path = path;
    return file;
  }

  async createFolder(path: string): Promise<void> {
    this.assertParentFolderExists(path);
    this.entries.set(path, { kind: 'folder' });
  }

  async create(path: string, data: string): Promise<AbstractFileLike> {
    if (this.entries.has(path)) {
      throw new Error(`already exists: ${path}`);
    }
    this.assertParentFolderExists(path);
    this.entries.set(path, { kind: 'file', content: data });
    const file = new this.TFileClass();
    file.path = path;
    return file;
  }

  async modify(file: AbstractFileLike, data: string): Promise<void> {
    this.entries.set(file.path, { kind: 'file', content: data });
  }

  async readBinary(file: AbstractFileLike): Promise<ArrayBuffer> {
    return this.entries.get(file.path)?.binaryContent ?? new ArrayBuffer(0);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<AbstractFileLike> {
    if (this.entries.has(path)) {
      throw new Error(`already exists: ${path}`);
    }
    this.assertParentFolderExists(path);
    this.entries.set(path, { kind: 'file', binaryContent: data });
    const file = new this.TFileClass();
    file.path = path;
    return file;
  }

  async modifyBinary(file: AbstractFileLike, data: ArrayBuffer): Promise<void> {
    this.entries.set(file.path, { kind: 'file', binaryContent: data });
  }

  contentAt(path: string): string | undefined {
    return this.entries.get(path)?.content;
  }

  binaryContentAt(path: string): ArrayBuffer | undefined {
    return this.entries.get(path)?.binaryContent;
  }
}

/** `createVaultFilePort`'s `state` port is unused by `writeConflictArtifact`. */
const noopState = {
  fileIdAtPath: () => null,
  baseHashFor: () => undefined,
  recordBaseHash: () => undefined,
  forgetBaseHash: () => undefined,
  recordPathOwner: () => undefined,
  forgetPath: () => undefined,
};

describe('registerVaultChangeListeners', () => {
  it('detaches exactly the listeners it registered when the disposer runs', async () => {
    // Regression: a re-pair used to leave the prior-session producer's vault
    // listeners attached (they were bound to plugin unload, not the connection),
    // so every edit was enqueued twice — once under the new identity (accepted)
    // and once under the stale prior-session identity (whole-request 403). The
    // connection handle's stop() now disposes the producer, so exactly the
    // listeners this producer added must be removed — no more, no fewer.
    const { registerVaultChangeListeners } = await import('./obsidian-adapters');

    const registered: unknown[] = [];
    const offed: unknown[] = [];
    const fakeVault = {
      on: (name: string) => {
        const ref = { name };
        registered.push(ref);
        return ref;
      },
      offref: (ref: unknown) => {
        offed.push(ref);
      },
    };

    const dispose = registerVaultChangeListeners(
      fakeVault as never,
      {
        onCreate: () => undefined,
        onModify: () => undefined,
        onDelete: () => undefined,
        onRename: () => undefined,
        onFolderRename: () => undefined,
        onFolderDelete: () => undefined,
      },
    );

    // Four change kinds: create, modify, delete, rename.
    expect(registered).toHaveLength(4);
    expect(offed).toHaveLength(0);

    dispose();

    // Every registered ref is detached, and only those refs.
    expect(offed).toEqual(registered);
  });
});

describe('registerVaultChangeListeners folder events (AUD-04)', () => {
  it('routes a TFolder rename/delete to the folder handlers and keeps TFile events on the per-file handlers', async () => {
    // Defence-in-depth: a folder-level move/delete from Obsidian or another
    // plugin must reach the folder handlers so child mappings are re-pathed or
    // tombstoned even if no per-child TFile event ever fires.
    const { registerVaultChangeListeners } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');

    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const fakeVault = {
      on: (name: string, callback: (...args: unknown[]) => unknown) => {
        listeners.set(name, callback);
        return { name };
      },
      offref: () => undefined,
    };

    const calls: string[] = [];
    registerVaultChangeListeners(fakeVault as never, {
      onCreate: (path) => calls.push(`create:${path}`),
      onModify: (path) => calls.push(`modify:${path}`),
      onDelete: (path) => calls.push(`delete:${path}`),
      onRename: (oldPath, newPath) => calls.push(`rename:${oldPath}->${newPath}`),
      onFolderRename: (oldPath, newPath) =>
        calls.push(`folderRename:${oldPath}->${newPath}`),
      onFolderDelete: (path) => calls.push(`folderDelete:${path}`),
    });

    const renamedFolder = new TFolder();
    renamedFolder.path = 'Archive/Sub';
    listeners.get('rename')?.(renamedFolder, 'Notes/Sub');

    const deletedFolder = new TFolder();
    deletedFolder.path = 'Notes/Gone';
    listeners.get('delete')?.(deletedFolder);

    const renamedFile = new TFile();
    renamedFile.path = 'Notes/New.md';
    listeners.get('rename')?.(renamedFile, 'Notes/Old.md');

    const deletedFile = new TFile();
    deletedFile.path = 'Notes/Removed.md';
    listeners.get('delete')?.(deletedFile);

    expect(calls).toEqual([
      'folderRename:Notes/Sub->Archive/Sub',
      'folderDelete:Notes/Gone',
      'rename:Notes/Old.md->Notes/New.md',
      'delete:Notes/Removed.md',
    ]);
  });
});

describe('createRequestUrlFn', () => {
  it('forwards the response text body Obsidian requestUrl returns', async () => {
    const { createRequestUrlFn } = await import('./obsidian-adapters');

    mockRequestUrl.mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: { ok: true },
      text: 'raw-blob-body',
    });

    const requestUrlFn = createRequestUrlFn();
    const response = await requestUrlFn({
      url: 'https://example.test/vaults/v1/blobs/hash',
      method: 'GET',
    });

    // This is the field resolveRevision() reads (response.text) to decode the
    // blob payload; omitting it makes every pull look empty and never
    // materializes remote notes on disk.
    expect(response.text).toBe('raw-blob-body');
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true });
  });

  it('does not read json eagerly, so a non-JSON error body never throws during response construction', async () => {
    // Regression: `.json` was read eagerly when building the response object. In
    // the real Obsidian runtime `.json` is a lazy getter that THROWS on a
    // non-JSON body (a 502/504 proxy HTML page, a Tailscale Funnel error page, an
    // empty body). Reading it eagerly made the whole transport call reject before
    // the consumer could inspect `status`, so a permanent 4xx delivered as HTML
    // was misclassified as thrown/offline and retried forever.
    const { createRequestUrlFn } = await import('./obsidian-adapters');

    let jsonReads = 0;
    mockRequestUrl.mockResolvedValue({
      status: 502,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: '<html>502 Bad Gateway</html>',
      get json() {
        jsonReads += 1;
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    const requestUrlFn = createRequestUrlFn();
    // Building the response must NOT touch `.json` (which throws here).
    const response = await requestUrlFn({
      url: 'https://proxy.test/vaults/v/events?after=0',
      method: 'GET',
    });

    expect(jsonReads).toBe(0);
    expect(response.status).toBe(502);
    expect(response.text).toBe('<html>502 Bad Gateway</html>');
    // Reading `.json` on a non-JSON body is guarded: it yields undefined, never
    // a throw, so status classification downstream always runs.
    expect(() => JSON.stringify(response.json)).not.toThrow();
    expect(response.json).toBeUndefined();
  });

  it('lets the transport classify a non-JSON error body by HTTP status instead of throwing a parse error', async () => {
    const { createRequestUrlFn } = await import('./obsidian-adapters');
    const { RequestUrlTransport } = await import('./sync-transport');

    const cases: ReadonlyArray<readonly [number, boolean]> = [
      [400, true], // permanent — quarantine, do not retry forever
      [502, false], // transient — retry with backoff
    ];
    for (const [status, permanent] of cases) {
      mockRequestUrl.mockResolvedValue({
        status,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: '<html>upstream error</html>',
        get json() {
          throw new SyntaxError('non-JSON body');
        },
      });

      const transport = new RequestUrlTransport({
        requestUrl: createRequestUrlFn(),
        apiBaseUrl: 'https://host',
        vaultId: 'vault-1',
        getAuthToken: async () => 'tok',
        resolveEnvelope: () => undefined,
      });

      await expect(transport.pull(0)).rejects.toMatchObject({
        name: 'RequestUrlTransportError',
        reason: 'http-status',
        permanent,
      });
    }
  });
});

describe('createVaultFilePort writeConflictArtifact', () => {
  it('creates the conflict folder on first write when absent', async () => {
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    await port.writeConflictArtifact('Havemind Conflicts/file-1-rev-1.md', 'C\n');

    expect(vault.contentAt('Havemind Conflicts/file-1-rev-1.md')).toBe('C\n');
    expect(vault.getAbstractFileByPath('Havemind Conflicts')).toBeInstanceOf(
      TFolder,
    );
  });

  it('overwrites an existing conflict artifact idempotently when the folder already exists', async () => {
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    await vault.createFolder('Havemind Conflicts');
    vault.seedFile('Havemind Conflicts/file-1-rev-1.md', 'OLD\n');
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    await port.writeConflictArtifact('Havemind Conflicts/file-1-rev-1.md', 'NEW\n');

    expect(vault.contentAt('Havemind Conflicts/file-1-rev-1.md')).toBe('NEW\n');
  });

  it('regression: a non-folder file occupying the reserved conflict-folder path must not wedge the pull loop', async () => {
    // A FILE (no extension) named exactly "Havemind Conflicts" satisfies
    // `getAbstractFileByPath(...) !== null`, so the old guard skipped
    // `createFolder` and the later `vault.create` threw because the parent
    // path was a file, not a folder. That throw bubbles to the sync cycle's
    // catch, which has no permanent-error classification on the pull path,
    // so every throw here was treated as 'offline' and backed off forever —
    // a single stray note wedged sync permanently. It must recover instead.
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    vault.seedFile('Havemind Conflicts'); // occupies the reserved path with a file
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    await expect(
      port.writeConflictArtifact('Havemind Conflicts/file-1-rev-1.md', 'C\n'),
    ).resolves.toBeUndefined();

    // The reserved file is left untouched, and the artifact still lands
    // somewhere retrievable rather than being silently dropped.
    expect(vault.getAbstractFileByPath('Havemind Conflicts')).toBeInstanceOf(
      TFile,
    );
    expect(
      vault.contentAt('Havemind Conflicts (files)/file-1-rev-1.md'),
    ).toBe('C\n');
  });
});

describe('createVaultFilePort binary attachments (F9)', () => {
  it('round-trips raw bytes byte-for-byte through writeBinaryByPath/readBinaryByPath', async () => {
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    const bytes = new Uint8Array([0x00, 0xff, 0x80, 10, 20, 30]);
    await port.writeBinaryByPath('Attachments/img.png', bytes);
    const read = await port.readBinaryByPath('Attachments/img.png');

    expect(read).toEqual(bytes);
  });

  it('returns null from readBinaryByPath when no file exists at the path', async () => {
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    expect(await port.readBinaryByPath('Attachments/missing.png')).toBeNull();
  });

  it('overwrites the on-disk bytes when writing binary to an existing path', async () => {
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    vault.seedBinaryFile('Attachments/img.png', new Uint8Array([1, 2, 3]).buffer);
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    const next = new Uint8Array([4, 5, 6, 7]);
    await port.writeBinaryByPath('Attachments/img.png', next);

    expect(await port.readBinaryByPath('Attachments/img.png')).toEqual(next);
  });

  it('writes a binary conflict artifact under Havemind Conflicts/ preserving the original extension', async () => {
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    const bytes = new Uint8Array([1, 2, 3]);
    await port.writeBinaryConflictArtifact(
      'Havemind Conflicts/file-1-rev-1.png',
      bytes,
    );

    const stored = vault.binaryContentAt('Havemind Conflicts/file-1-rev-1.png');
    expect(stored).toBeDefined();
    expect(new Uint8Array(stored as ArrayBuffer)).toEqual(bytes);
    expect(vault.getAbstractFileByPath('Havemind Conflicts')).toBeInstanceOf(
      TFolder,
    );
  });

  it('overwrites an existing binary conflict artifact idempotently', async () => {
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    await vault.createFolder('Havemind Conflicts');
    vault.seedBinaryFile(
      'Havemind Conflicts/file-1-rev-1.png',
      new Uint8Array([9, 9]).buffer,
    );
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    const next = new Uint8Array([1, 2, 3]);
    await port.writeBinaryConflictArtifact(
      'Havemind Conflicts/file-1-rev-1.png',
      next,
    );

    const stored = vault.binaryContentAt('Havemind Conflicts/file-1-rev-1.png');
    expect(new Uint8Array(stored as ArrayBuffer)).toEqual(next);
  });
});

describe('createVaultFilePort ensures parent folders on create-materialization', () => {
  it('regression (5-day field outage): creating a file in a not-yet-existing folder makes the folder first instead of throwing', async () => {
    // A freshly onboarded vault pulls a remote create for `Notatki/Start.md`
    // but has no `Notatki` folder. Real Obsidian's `vault.create` THROWS when
    // the parent folder is missing (the fidelity-fixed FakeVault now models
    // that throw), and that throw bubbled to the pull cycle — which has no
    // permanent-error classification on the apply path — so the cursor never
    // advanced and sync wedged on 'Offline — will retry' forever. The port must
    // materialize the parent folder first.
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    await port.writeByPath('Notatki/Start pilotażu.md', 'S\n');

    expect(vault.contentAt('Notatki/Start pilotażu.md')).toBe('S\n');
    expect(vault.getAbstractFileByPath('Notatki')).toBeInstanceOf(TFolder);
  });

  it('creates a DEEP nested folder hierarchy level by level for A/B/C/x.md', async () => {
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    await port.writeByPath('A/B/C/x.md', 'X\n');

    expect(vault.contentAt('A/B/C/x.md')).toBe('X\n');
    expect(vault.getAbstractFileByPath('A')).toBeInstanceOf(TFolder);
    expect(vault.getAbstractFileByPath('A/B')).toBeInstanceOf(TFolder);
    expect(vault.getAbstractFileByPath('A/B/C')).toBeInstanceOf(TFolder);
  });

  it('creates the parent folder for a binary create into a missing folder (F9)', async () => {
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await port.writeBinaryByPath('assets/img/photo.png', bytes);

    expect(await port.readBinaryByPath('assets/img/photo.png')).toEqual(bytes);
    expect(vault.getAbstractFileByPath('assets')).toBeInstanceOf(TFolder);
    expect(vault.getAbstractFileByPath('assets/img')).toBeInstanceOf(TFolder);
  });

  it('reuses an existing ancestor folder and never re-creates it', async () => {
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    vault.seedFolder('Notatki');
    vault.seedFile('Notatki/existing.md', 'E\n');
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    await port.writeByPath('Notatki/new.md', 'N\n');

    expect(vault.contentAt('Notatki/new.md')).toBe('N\n');
    // The pre-existing sibling is untouched.
    expect(vault.contentAt('Notatki/existing.md')).toBe('E\n');
  });

  it('an overwrite/modify of an existing file needs no folder work', async () => {
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    vault.seedFolder('Notatki');
    vault.seedFile('Notatki/note.md', 'OLD\n');
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    await port.writeByPath('Notatki/note.md', 'NEW\n');

    expect(vault.contentAt('Notatki/note.md')).toBe('NEW\n');
  });

  it('throws ParentFolderOccupiedError (a per-item failure) when a FILE occupies an ancestor path', async () => {
    // A file literally named `Notatki` (no extension) occupies the path where a
    // folder is needed for `Notatki/Start.md`. The hierarchy cannot be created,
    // so the port throws the typed permanent error the apply side diverts to a
    // conflict artifact — never a silent overwrite of the occupying file, and
    // never a cycle-killing throw.
    const { createVaultFilePort } = await import('./obsidian-adapters');
    const { ParentFolderOccupiedError } = await import('./vault-apply');
    const { TFile, TFolder } = await import('obsidian');
    const vault = new FakeVault(TFile, TFolder);
    vault.seedFile('Notatki'); // a FILE occupying the would-be folder path
    const port = createVaultFilePort({
      vault: vault as never,
      state: noopState as never,
    });

    await expect(
      port.writeByPath('Notatki/Start.md', 'S\n'),
    ).rejects.toBeInstanceOf(ParentFolderOccupiedError);
    // The occupying file is left untouched.
    expect(vault.getAbstractFileByPath('Notatki')).toBeInstanceOf(TFile);
  });
});

describe('createSchedulerHooks focus/online listener disposal (MINOR)', () => {
  it('returns real disposers that remove the exact listeners they added', async () => {
    const { createSchedulerHooks } = await import('./obsidian-adapters');
    const added: Array<{ type: string; listener: () => void }> = [];
    const removed: Array<{ type: string; listener: () => void }> = [];
    const target = {
      addEventListener: (type: string, listener: () => void) =>
        void added.push({ type, listener }),
      removeEventListener: (type: string, listener: () => void) =>
        void removed.push({ type, listener }),
    };
    const plugin = {
      registerInterval: vi.fn(),
    } as unknown as Parameters<typeof createSchedulerHooks>[0];

    const hooks = createSchedulerHooks(plugin, target);
    const onFocusRun = (): void => undefined;
    const onOnlineRun = (): void => undefined;

    const disposeFocus = hooks.onFocus(onFocusRun);
    const disposeOnline = hooks.onOnline(onOnlineRun);
    expect(added).toEqual([
      { type: 'focus', listener: onFocusRun },
      { type: 'online', listener: onOnlineRun },
    ]);

    // stop() calls the disposers: they must actually remove the listeners.
    disposeFocus();
    disposeOnline();
    expect(removed).toEqual([
      { type: 'focus', listener: onFocusRun },
      { type: 'online', listener: onOnlineRun },
    ]);
  });
});

describe('createPersistPort atomic write + backup (GAP-1)', () => {
  /** Minimal plugin double exposing only the data blob surface the port uses. */
  function fakePlugin(
    disk: { value: Record<string, unknown> },
    onSave?: (call: number) => void,
  ) {
    let saveCalls = 0;
    return {
      async loadData() {
        return disk.value;
      },
      async saveData(data: unknown) {
        saveCalls += 1;
        onSave?.(saveCalls);
        disk.value = data as Record<string, unknown>;
      },
    } as unknown as Plugin;
  }

  it('retains the previous good primary when the promote write is torn mid-save', async () => {
    const { createPersistPort } = await import('./obsidian-adapters');
    const goodPrimary = { version: 1, cursor: 1, outbox: [], locallyAuthored: [], deferred: [] };
    const disk = { value: { syncState: goodPrimary } as Record<string, unknown> };
    // The atomic save writes twice (stage, then promote). Fail the promote.
    const plugin = fakePlugin(disk, (call) => {
      if (call === 2) throw new Error('torn write');
    });
    const port = createPersistPort(plugin);

    const newState = {
      version: 1 as const,
      cursor: 99,
      outbox: [],
      locallyAuthored: [],
      deferred: [],
      quarantine: [],
      pathOwners: {},
      baseHashes: {},
      baseContents: {},
      conflictArtifacts: {},
      quarantinedEnvelopes: {},
    };
    await expect(port.save(newState)).rejects.toThrow('torn write');

    // The primary on disk is still the previous good blob, and it is loadable.
    expect(await port.load()).toEqual(goodPrimary);
  });

  it('promotes the staged blob and retains exactly one previous-good .bak', async () => {
    const { createPersistPort } = await import('./obsidian-adapters');
    const first = { version: 1, cursor: 1, outbox: [], locallyAuthored: [], deferred: [] };
    const disk = { value: { syncState: first } as Record<string, unknown> };
    const port = createPersistPort(fakePlugin(disk));

    const second = {
      version: 1 as const,
      cursor: 2,
      outbox: [],
      locallyAuthored: [],
      deferred: [],
      quarantine: [],
      pathOwners: {},
      baseHashes: {},
      baseContents: {},
      conflictArtifacts: {},
      quarantinedEnvelopes: {},
    };
    await port.save(second);

    // New primary installed; prior primary demoted to the single backup; the
    // staging slot cleared.
    expect((await port.load()) as { cursor: number }).toMatchObject({ cursor: 2 });
    expect((await port.loadBackup()) as { cursor: number }).toMatchObject({ cursor: 1 });
    expect(disk.value['syncState.staging']).toBeUndefined();
  });

  it('preserves a corrupt blob under a timestamped sidecar without clobbering an existing one', async () => {
    const { createPersistPort } = await import('./obsidian-adapters');
    const disk = { value: {} as Record<string, unknown> };
    const port = createPersistPort(fakePlugin(disk));

    await port.preserveCorrupt({ bad: 'blob' }, 1000);
    expect(disk.value['syncStateCorrupt.1000']).toEqual({ bad: 'blob' });

    // A second call at the SAME timestamp must not clobber the existing sidecar.
    await port.preserveCorrupt({ different: 'blob' }, 1000);
    expect(disk.value['syncStateCorrupt.1000']).toEqual({ bad: 'blob' });
  });
});

describe('parseProducerStateResult (GAP-3 fail-closed producer state)', () => {
  const validMapping = {
    collisionKey: 'k1',
    content: 'hello',
    contentHash: 'h1',
    fileId: 'f1',
    path: 'Note.md',
  };

  it('treats an ABSENT producer state as a clean first run with no signal', async () => {
    const { parseProducerStateResult } = await import('./obsidian-adapters');

    for (const raw of [null, undefined]) {
      const result = parseProducerStateResult(raw);
      expect(result.status).toBe('absent');
      expect(result.state).toEqual({ mappings: [], heads: {} });
      expect(result.quarantinedMappings).toEqual([]);
    }
  });

  it('keeps valid mappings and PRESERVES one malformed mapping (not silently dropped)', async () => {
    const { parseProducerStateResult } = await import('./obsidian-adapters');
    const badMapping = { collisionKey: 'k2', fileId: 42 /* wrong type */ };
    const result = parseProducerStateResult({
      mappings: [validMapping, badMapping],
      heads: {},
    });

    expect(result.status).toBe('ok');
    // The valid sibling survives.
    expect(result.state.mappings).toHaveLength(1);
    expect(result.state.mappings[0]?.fileId).toBe('f1');
    // The bad entry is preserved (quarantined) for recovery — a recoverable signal.
    expect(result.quarantinedMappings).toEqual([badMapping]);
  });

  it('fails CLOSED on a structurally-broken container and does not silently empty a populated set', async () => {
    const { parseProducerStateResult } = await import('./obsidian-adapters');
    // A previously-populated mapping set arrives with a broken (non-record) heads
    // container. This must be reported as corrupt (so the caller preserves the raw
    // bytes) rather than degrading to a clean, signal-free empty like an absent blob.
    const result = parseProducerStateResult({
      mappings: [validMapping],
      heads: 'not-a-record',
    });

    expect(result.status).toBe('corrupt');
    // It does not throw and returns a usable (empty) state so connect proceeds.
    expect(result.state).toEqual({ mappings: [], heads: {} });
  });

  it('reports a non-record raw (wrong shape) as corrupt, not absent', async () => {
    const { parseProducerStateResult } = await import('./obsidian-adapters');
    const result = parseProducerStateResult(['not', 'an', 'object']);
    expect(result.status).toBe('corrupt');
  });

  it('parses heads alongside mappings on the ok path', async () => {
    const { parseProducerStateResult } = await import('./obsidian-adapters');
    const result = parseProducerStateResult({
      mappings: [validMapping],
      heads: { f1: 'rev-1', bad: 99 /* dropped: non-string */ },
    });

    expect(result.status).toBe('ok');
    expect(result.state.heads).toEqual({ f1: 'rev-1' });
    expect(result.state.mappings).toHaveLength(1);
  });

  it('NEVER throws on arbitrary garbage (connect-safety)', async () => {
    const { parseProducerStateResult } = await import('./obsidian-adapters');
    for (const raw of [42, 'string', true, [1, 2, 3], { mappings: 5 }]) {
      expect(() => parseProducerStateResult(raw)).not.toThrow();
    }
  });

  it('parseProducerState stays a ProducerState-returning wrapper (backward compatible)', async () => {
    const { parseProducerState } = await import('./obsidian-adapters');
    const state = parseProducerState({ mappings: [validMapping], heads: { f1: 'r' } });
    expect(state.mappings).toHaveLength(1);
    expect(state.heads).toEqual({ f1: 'r' });
  });
});

describe('preserveCorruptProducerState (GAP-3 sidecar)', () => {
  function fakePlugin(disk: { value: Record<string, unknown> }) {
    return {
      async loadData() {
        return disk.value;
      },
      async saveData(data: unknown) {
        disk.value = data as Record<string, unknown>;
      },
    } as unknown as Plugin;
  }

  it('preserves the raw blob under a timestamped producer sidecar without clobbering', async () => {
    const { preserveCorruptProducerState } = await import('./obsidian-adapters');
    const disk = { value: {} as Record<string, unknown> };
    const plugin = fakePlugin(disk);

    await preserveCorruptProducerState(plugin, { bad: 'producer' }, 2000);
    expect(disk.value['pushProducerCorrupt.2000']).toEqual({ bad: 'producer' });

    // A second call at the SAME timestamp must not clobber the existing sidecar.
    await preserveCorruptProducerState(plugin, { other: 'blob' }, 2000);
    expect(disk.value['pushProducerCorrupt.2000']).toEqual({ bad: 'producer' });
  });
});

describe('buildRejoinControllerForInvitee role gate (sweep-P1)', () => {
  function fakePlugin(data: Record<string, unknown>) {
    return {
      async loadData() {
        return data;
      },
      async saveData() {
        /* no-op */
      },
    } as unknown as Plugin;
  }

  it('returns null for an OWNER connection (owner self-rejoin is a dead-end — never arm the doomed poll)', async () => {
    // An authenticated owner session is required to issue a rejoin grant, which a
    // burned owner lacks: owner rejoin can never succeed. So no controller is
    // built for an owner connection and the doomed /auth/rejoin poll never arms.
    const { buildRejoinControllerForInvitee } = await import('./obsidian-adapters');
    const plugin = fakePlugin({
      ownerConnection: {
        apiBaseUrl: 'https://sync.example.test',
        vaultId: 'vault-1',
        memberId: 'm-owner',
        deviceId: 'd-owner',
      },
    });

    const controller = await buildRejoinControllerForInvitee(plugin);
    expect(controller).toBeNull();
  });
});

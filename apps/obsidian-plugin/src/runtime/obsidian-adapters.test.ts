import { describe, expect, it, vi } from 'vitest';

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

  seedBinaryFile(path: string, data: ArrayBuffer): void {
    this.entries.set(path, { kind: 'file', binaryContent: data });
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
    this.entries.set(path, { kind: 'folder' });
  }

  async create(path: string, data: string): Promise<AbstractFileLike> {
    if (this.entries.has(path)) {
      throw new Error(`already exists: ${path}`);
    }
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

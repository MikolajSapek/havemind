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
});

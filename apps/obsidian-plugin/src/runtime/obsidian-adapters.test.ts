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

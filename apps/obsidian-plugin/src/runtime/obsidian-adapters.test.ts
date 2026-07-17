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

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFetchRequestUrl } from './fetch-request-url';

afterEach(() => vi.unstubAllGlobals());

describe('the agents service reaches the server next to it (plan 015)', () => {
  it('keeps the path and query, and swaps only the origin', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return new Response('{"ok":true}', { status: 200 });
    });
    const request = createFetchRequestUrl('http://havemind-server:8787');
    const response = await request({ url: 'https://box.tail0.ts.net/vaults/v/events?after=3', method: 'GET' });
    expect(seen).toEqual(['http://havemind-server:8787/vaults/v/events?after=3']);
    expect(response.json).toEqual({ ok: true });
    await createFetchRequestUrl()({ url: 'https://box.example/x', method: 'GET' });
    expect(seen[1]).toBe('https://box.example/x');
  });
});

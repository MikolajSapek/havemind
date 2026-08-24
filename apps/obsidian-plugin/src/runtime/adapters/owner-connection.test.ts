import { describe, expect, it } from 'vitest';

import { parseOwnerConnection } from './owner-connection';

describe('parseOwnerConnection', () => {
  it.each([
    'http://sync.example',
    'https://sync.example/api',
    'https://user:password@sync.example',
    'not a url',
  ])('rejects an untrusted persisted API URL: %s', (apiBaseUrl) => {
    expect(
      parseOwnerConnection({ apiBaseUrl, vaultId: 'vault-1' }),
    ).toMatchObject({ status: 'corrupt' });
  });

  it('accepts a canonical HTTPS origin', () => {
    expect(
      parseOwnerConnection({
        apiBaseUrl: 'https://sync.example',
        vaultId: 'vault-1',
      }),
    ).toMatchObject({
      status: 'connection',
      connection: { apiBaseUrl: 'https://sync.example', vaultId: 'vault-1' },
    });
  });
});

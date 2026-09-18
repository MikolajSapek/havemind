/**
 * A token failure must say why, not vanish.
 *
 * The connection handle's `getAccessToken` wrapped the provider in a bare
 * `catch { return null }`. When minting failed, every caller saw an empty value
 * and nothing else: the sync loop stopped issuing requests, the panel kept
 * showing the last successful cycle ("Connected, synced"), the outbox grew, and
 * the server logged no traffic at all. Diagnosing it from the outside was
 * impossible because the one fact that mattered, the thrown reason, had been
 * discarded at the only place that saw it.
 *
 * Callers still get `null`, because a missing token is an ordinary offline
 * condition they already handle. What changes is that the reason is recorded
 * and surfaced, so the next occurrence names itself.
 */

import { describe, expect, it, vi } from 'vitest';

import { createDiagnosticAccessToken } from './access-token-diagnostics';

describe('createDiagnosticAccessToken', () => {
  it('passes a token through unchanged', async () => {
    const getToken = createDiagnosticAccessToken(async () => 'token-abc');
    expect(await getToken()).toBe('token-abc');
  });

  it('returns null when minting fails, as callers expect', async () => {
    const getToken = createDiagnosticAccessToken(async () => {
      throw new Error('No refresh token is stored.');
    });
    expect(await getToken()).toBeNull();
  });

  it('reports the reason instead of discarding it', async () => {
    const onFailure = vi.fn();
    const getToken = createDiagnosticAccessToken(
      async () => {
        throw new Error('No refresh token is stored.');
      },
      { onFailure },
    );

    await getToken();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[0]).toContain('No refresh token is stored');
  });

  it('describes a thrown non-Error too', async () => {
    // A rejected promise carrying a string or object must still produce a
    // readable line; "undefined" in a log is what made this invisible before.
    const onFailure = vi.fn();
    const getToken = createDiagnosticAccessToken(
      async () => {
        throw 'secret storage unavailable';
      },
      { onFailure },
    );

    await getToken();

    expect(onFailure.mock.calls[0]?.[0]).toContain('secret storage unavailable');
  });

  it('reports every failure, so a persistent fault stays visible', async () => {
    const onFailure = vi.fn();
    const getToken = createDiagnosticAccessToken(
      async () => {
        throw new Error('boom');
      },
      { onFailure },
    );

    await getToken();
    await getToken();
    await getToken();

    expect(onFailure).toHaveBeenCalledTimes(3);
  });

  it('remembers the last failure for the panel to read', async () => {
    const getToken = createDiagnosticAccessToken(async () => {
      throw new Error('No refresh token is stored.');
    });

    await getToken();

    expect(getToken.lastFailure).toContain('No refresh token is stored');
  });

  it('clears the remembered failure once a token succeeds', async () => {
    let fail = true;
    const getToken = createDiagnosticAccessToken(async () => {
      if (fail) throw new Error('transient');
      return 'token-abc';
    });

    await getToken();
    expect(getToken.lastFailure).not.toBeNull();

    fail = false;
    await getToken();
    expect(getToken.lastFailure).toBeNull();
  });
});

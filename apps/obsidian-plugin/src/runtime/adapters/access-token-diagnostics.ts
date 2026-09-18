/**
 * Wraps access-token minting so a failure names itself.
 *
 * The connection handle used to expose `getAccessToken` as a bare
 * `try { ... } catch { return null }`. Callers treat a null token as "offline
 * for now", which is right, but the thrown reason was discarded at the only
 * point in the system that ever saw it. When minting started failing on a
 * desktop, the result was a device that issued no requests at all while the
 * panel still showed the last successful cycle: the outbox grew, the server
 * logged nothing, and nothing anywhere said why. It took a manual console probe
 * to discover that the token was simply absent.
 *
 * The contract for callers is unchanged (a failure still yields null). What
 * changes is that the reason is reported and remembered, so the next occurrence
 * is visible in the console and readable by the panel.
 */

/** A token getter that also carries why it last failed, if it did. */
export interface DiagnosticAccessToken {
  (): Promise<string | null>;
  /** The most recent failure reason, or null when the last attempt succeeded. */
  lastFailure: string | null;
}

export interface AccessTokenDiagnosticsOptions {
  /** Called with a readable reason on every failed attempt. */
  readonly onFailure?: (reason: string) => void;
}

/** A readable one-liner for anything a rejected promise may carry. */
function describe(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  try {
    return JSON.stringify(error) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}

export function createDiagnosticAccessToken(
  mint: () => Promise<string>,
  options: AccessTokenDiagnosticsOptions = {},
): DiagnosticAccessToken {
  const report =
    options.onFailure ??
    ((reason: string) => {
      console.warn(`Havemind: could not mint an access token: ${reason}`);
    });

  const getToken = (async () => {
    try {
      const token = await mint();
      getToken.lastFailure = null;
      return token;
    } catch (error) {
      const reason = describe(error);
      getToken.lastFailure = reason;
      // Every failure, not just the first: a fault that persists must stay
      // visible, because the symptom (silence) looks identical to health.
      report(reason);
      return null;
    }
  }) as DiagnosticAccessToken;

  getToken.lastFailure = null;
  return getToken;
}

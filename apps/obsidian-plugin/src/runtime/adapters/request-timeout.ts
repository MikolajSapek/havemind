/**
 * Bounds how long a network request may hang.
 *
 * Obsidian's `requestUrl` takes no timeout: `RequestUrlParam` carries url,
 * method, contentType, body, headers and throw, and nothing else. A request
 * whose connection dies without closing therefore never settles. On a phone
 * that is ordinary, not exotic: walking out of Wi-Fi range drops the network
 * with no FIN, and the sync loop then waits forever on a promise nothing will
 * resolve, with every retry and reconnect queued behind it.
 *
 * Rejecting after a bound hands control back to the loop's existing failure
 * handling, which already knows how to back off and reconnect.
 */

/**
 * Default ceiling for one request.
 *
 * Must exceed the server's 25s `/wait` hold (`sync-routes.ts`), or every
 * long poll would be killed as a timeout; a minute leaves room for a slow
 * mobile link without leaving a dead request pending for the rest of the day.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Marks a request abandoned by the client, distinct from a server error. */
export class RequestTimeoutError extends Error {
  public override readonly name = 'RequestTimeoutError';

  public constructor(ms: number) {
    super(`Request timed out after ${ms}ms`);
  }
}

/**
 * Resolves with `request`, or rejects once `ms` has passed.
 *
 * The timer is always cleared, including on the failure path: one pending timer
 * per request would keep the event loop awake for nothing.
 */
export async function withRequestTimeout<T>(
  request: Promise<T>,
  ms: number = REQUEST_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RequestTimeoutError(ms)), ms);
  });
  try {
    // `race` attaches to both, so the request's own rejection still surfaces
    // as itself rather than being masked by the timeout.
    return await Promise.race([request, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The single adapter that wraps Obsidian's `requestUrl` as the transport's
 * injectable `RequestUrlFn`. Its whole reason to exist is the lazy-`.json`
 * guard documented inline: the real runtime's `.json` is a getter that THROWS on
 * a non-JSON body, so reading it eagerly would defeat status-based error
 * classification everywhere downstream. Every networked adapter builds its
 * transport through this one function.
 */

import { requestUrl } from 'obsidian';

import type { RequestUrlFn } from '../sync-transport';

/** Wraps Obsidian's `requestUrl` as the transport's `RequestUrlFn`. */
export function createRequestUrlFn(): RequestUrlFn {
  return async (options) => {
    const response = await requestUrl({
      url: options.url,
      method: options.method,
      throw: false,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    // `.json` is a LAZY getter in the real Obsidian runtime that THROWS on a
    // non-JSON body (a 502/504 proxy HTML page, a Tailscale Funnel error page, an
    // empty body). Reading it eagerly here made the whole transport call reject
    // before the consumer could inspect `status`, so a permanent 4xx delivered as
    // HTML was misclassified as thrown/offline and retried forever. Expose it as a
    // guarded lazy accessor instead: the transport reads `.json` only AFTER its
    // status check passes, and a non-JSON body yields `undefined` rather than a
    // throw — so status-based classification (ensureOk / isPermanentStatus) always
    // runs. `.text` is a plain field that never throws and is forwarded eagerly.
    return {
      status: response.status,
      text: response.text,
      get json(): unknown {
        try {
          return response.json;
        } catch {
          return undefined;
        }
      },
    };
  };
}

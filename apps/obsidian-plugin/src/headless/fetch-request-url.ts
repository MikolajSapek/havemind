/**
 * The transport's `RequestUrlFn` over Node's `fetch`, for the headless agent.
 * Same contract as the plugin's `requestUrl` adapter: never throws on a status,
 * exposes `.json` lazily (undefined for a non-JSON body) and the raw bytes.
 */

import { REQUEST_TIMEOUT_MS } from '../runtime/adapters/request-timeout';
import type { RequestUrlFn } from '../runtime/sync-transport';

/**
 * `serverUrl`, when given, carries every request instead of the public
 * address: the agents service sits next to the server on the same Compose
 * network and reaches it as http://havemind-server:8787, with no tailnet name,
 * certificate or host networking involved. Only the origin changes.
 */
export function createFetchRequestUrl(serverUrl?: string): RequestUrlFn {
  return async (options) => {
    const target = serverUrl === undefined || serverUrl === ''
      ? options.url
      : (() => {
          const url = new URL(options.url);
          return new URL(`${url.pathname}${url.search}`, serverUrl).toString();
        })();
    const response = await fetch(target, {
      method: options.method,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const arrayBuffer = await response.arrayBuffer();
    return {
      status: response.status,
      arrayBuffer,
      get json(): unknown {
        try {
          return JSON.parse(new TextDecoder().decode(arrayBuffer)) as unknown;
        } catch {
          return undefined;
        }
      },
    };
  };
}

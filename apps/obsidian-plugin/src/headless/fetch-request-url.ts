/**
 * The transport's `RequestUrlFn` over Node's `fetch`, for the headless agent.
 * Same contract as the plugin's `requestUrl` adapter: never throws on a status,
 * exposes `.json` lazily (undefined for a non-JSON body) and the raw bytes.
 */

import { REQUEST_TIMEOUT_MS } from '../runtime/adapters/request-timeout';
import type { RequestUrlFn } from '../runtime/sync-transport';

export function createFetchRequestUrl(): RequestUrlFn {
  return async (options) => {
    const response = await fetch(options.url, {
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

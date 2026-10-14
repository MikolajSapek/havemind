/**
 * The owner's one-click agent calls (plan 015): add an agent, and set or
 * check the model key. Free of Obsidian, so it is tested on its own. The key
 * travels only in the PUT body, over the vault's HTTPS connection; nothing
 * here keeps it, logs it or puts it in an error message.
 */

import type { RequestUrlFn } from './sync-transport';

export interface AgentApiOptions {
  readonly requestUrl: RequestUrlFn;
  readonly apiBaseUrl: string;
  readonly vaultId: string;
  readonly getAccessToken: () => Promise<string>;
}

export type AddAgentResult = 'added' | 'name-taken' | 'unsupported' | 'failed';

async function call(options: AgentApiOptions, method: string, path: string, body?: unknown) {
  const token = await options.getAccessToken();
  return options.requestUrl({
    url: `${options.apiBaseUrl}/vaults/${encodeURIComponent(options.vaultId)}${path}`,
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    throw: false,
  });
}

export async function addAgent(options: AgentApiOptions, name: string): Promise<AddAgentResult> {
  const response = await call(options, 'POST', '/agents', { name });
  if (response.status === 201) return 'added';
  if (response.status === 409) return 'name-taken';
  // A server without an agents service has no such route.
  if (response.status === 404) return 'unsupported';
  return 'failed';
}

/** True or false once known; null on a server that cannot add agents. */
export async function modelKeyConfigured(options: AgentApiOptions): Promise<boolean | null> {
  const response = await call(options, 'GET', '/agent-model');
  if (response.status !== 200) return null;
  const body = response.json as { configured?: unknown } | undefined;
  return body?.configured === true;
}

/** The server's model login: a Claude subscription token or an API key (plan 016). */
export type ServerLogin = { readonly kind: 'subscription' | 'api-key'; readonly secret: string };

export async function setModelKey(
  options: AgentApiOptions,
  key: string | ServerLogin,
): Promise<'saved' | 'invalid' | 'failed'> {
  const login: ServerLogin = typeof key === 'string' ? { kind: 'api-key', secret: key } : key;
  const body = login.kind === 'subscription' ? { oauthToken: login.secret.trim() } : { key: login.secret.trim() };
  const response = await call(options, 'PUT', '/agent-model', body);
  if (response.status === 204) return 'saved';
  if (response.status === 400) return 'invalid';
  return 'failed';
}

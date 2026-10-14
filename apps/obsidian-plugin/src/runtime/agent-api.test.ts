import { describe, expect, it } from 'vitest';

import { addAgent, modelKeyConfigured, setModelKey, type AgentApiOptions } from './agent-api';
import type { RequestUrlOptions } from './sync-transport';

function api(status: number, json?: unknown) {
  const calls: RequestUrlOptions[] = [];
  const options: AgentApiOptions = {
    apiBaseUrl: 'https://box.example.ts.net',
    vaultId: 'v-1',
    getAccessToken: async () => 'hm_at_token',
    requestUrl: async (request) => {
      calls.push(request);
      return { status, json };
    },
  };
  return { calls, options };
}

describe('adding an agent with one click (plan 015)', () => {
  it('posts the name to the owner route with the session', async () => {
    const { calls, options } = api(201, { enrollmentId: 'e-1' });
    expect(await addAgent(options, 'Inbox sorter')).toBe('added');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://box.example.ts.net/vaults/v-1/agents' });
    expect(calls[0]?.headers?.authorization).toBe('Bearer hm_at_token');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ name: 'Inbox sorter' });
  });

  it('tells a taken name and an older server apart', async () => {
    expect(await addAgent(api(409).options, 'Bob')).toBe('name-taken');
    expect(await addAgent(api(404).options, 'X')).toBe('unsupported');
    expect(await addAgent(api(500).options, 'X')).toBe('failed');
  });

  it('reads whether the server has a model key, and never more', async () => {
    expect(await modelKeyConfigured(api(200, { configured: true }).options)).toBe(true);
    expect(await modelKeyConfigured(api(200, { configured: false }).options)).toBe(false);
    expect(await modelKeyConfigured(api(404).options)).toBeNull();
  });

  it('sends the key once, trimmed, only in the body', async () => {
    const { calls, options } = api(204);
    expect(await setModelKey(options, '  sk-ant-api03-abcdefghijklmnopqrstuvwxyz  ')).toBe('saved');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).not.toContain('sk-ant');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' });
    expect(await setModelKey(api(400).options, 'nope')).toBe('invalid');
  });

  it('sends a Claude subscription token under its own name (plan 016)', async () => {
    const { calls, options } = api(204);
    expect(await setModelKey(options, { kind: 'subscription', secret: 'sk-ant-oat01-abc' })).toBe('saved');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ oauthToken: 'sk-ant-oat01-abc' });
  });
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RequestUrlFn } from '../runtime/sync-transport';

import { claimNextAgent, folderFor, resolveAgentFolder, uniqueFolder } from './claim';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hm-claim-'));
  dirs.push(dir);
  return dir;
}

function server(name: string, membershipId: string, vaultId = 'vault-1'): RequestUrlFn {
  return async () => ({
    status: 200,
    json: { apiBaseUrl: 'https://x.test', vaultId, vaultName: 'V', membershipId, deviceId: `d-${membershipId}`, name },
    arrayBuffer: new ArrayBuffer(0),
  });
}

const claim = (dir: string, requestUrl: RequestUrlFn) =>
  claimNextAgent({ agentsDir: dir, apiBaseUrl: 'https://x.test', serviceToken: 't', requestUrl });

const identityOf = (dir: string, folder: string): { memberId: string; name: string } =>
  JSON.parse(readFileSync(join(dir, folder, 'state', 'identity.json'), 'utf8')) as { memberId: string; name: string };

describe('agent folders (plan 018 item 11)', () => {
  it('maps different names onto one base, which is why a claim must not trust it', () => {
    expect(folderFor('Mail Bot')).toBe(folderFor('Mail-Bot'));
  });

  it('never lets a second agent overwrite the first one that has the same base folder', async () => {
    const dir = agentsDir();
    const first = await claim(dir, server('Mail Bot', 'member-aaaa1111'));
    const second = await claim(dir, server('Mail-Bot', 'member-bbbb2222'));
    expect(first).toBe('mail-bot');
    expect(second).not.toBe(first);
    expect(identityOf(dir, 'mail-bot')).toMatchObject({ memberId: 'member-aaaa1111', name: 'Mail Bot' });
    expect(identityOf(dir, second ?? '')).toMatchObject({ memberId: 'member-bbbb2222', name: 'Mail-Bot' });
  });

  it('keeps two vaults\' agents of the same name apart', async () => {
    const dir = agentsDir();
    const one = await claim(dir, server('Sorter', 'member-aaaa1111', 'vault-1'));
    const two = await claim(dir, server('Sorter', 'member-bbbb2222', 'vault-2'));
    expect(one).not.toBe(two);
    expect(identityOf(dir, one ?? '').memberId).toBe('member-aaaa1111');
  });

  it('gives a repeated claim of the same member its own folder back', async () => {
    const dir = agentsDir();
    const first = await claim(dir, server('Sorter', 'member-aaaa1111'));
    const again = await uniqueFolder(dir, 'Sorter', 'member-aaaa1111');
    expect(again).toBe(first);
  });
});

describe('naming an agent on the command line (plan 018 item 11)', () => {
  it('finds a claimed agent by its own name even when its folder carries a suffix', async () => {
    const dir = agentsDir();
    await claim(dir, server('Mail Bot', 'member-aaaa1111'));
    const second = await claim(dir, server('Mail-Bot', 'member-bbbb2222'));
    expect(await resolveAgentFolder(dir, 'Mail-Bot')).toBe(second);
    expect(await resolveAgentFolder(dir, 'Mail Bot')).toBe('mail-bot');
    expect(await resolveAgentFolder(dir, 'mail-bot')).toBe('mail-bot');
    expect(await resolveAgentFolder(dir, second ?? '')).toBe(second);
    expect(await resolveAgentFolder(dir, 'Someone New')).toBe('someone-new');
  });

  it('refuses a name two agents share', async () => {
    const dir = agentsDir();
    await claim(dir, server('Sorter', 'member-aaaa1111', 'vault-1'));
    await claim(dir, server('Sorter', 'member-bbbb2222', 'vault-2'));
    await expect(resolveAgentFolder(dir, 'Sorter')).rejects.toThrow(/More than one/u);
  });
});

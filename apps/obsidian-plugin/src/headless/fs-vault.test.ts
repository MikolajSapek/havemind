import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openFsVault } from './fs-vault';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('a vault that is a folder (plan 014)', () => {
  it('never reads or writes outside its folder, whatever path a revision carries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hm-fsvault-'));
    roots.push(root);
    const { vault, snapshot } = await openFsVault(root);
    const v = vault as { create(path: string, text: string): Promise<unknown> };
    await expect(v.create('../escape.md', 'x')).rejects.toThrow(/escapes the vault/u);
    await expect(snapshot.readText('a/../../escape.md')).rejects.toThrow(/escapes the vault/u);
  });

  it('lists notes but not its trash or settings folders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hm-fsvault-'));
    roots.push(root);
    const { vault, snapshot } = await openFsVault(root);
    const v = vault as {
      createFolder(path: string): Promise<void>;
      create(path: string, text: string): Promise<{ path: string }>;
      trash(file: { path: string }): Promise<void>;
      getAbstractFileByPath(path: string): { path: string; children?: unknown } | null;
    };
    await v.createFolder('Inbox');
    await v.create('Inbox/a.md', 'a');
    const gone = await v.create('b.md', 'b');
    await v.trash(gone);
    expect(await snapshot.listSyncablePaths()).toEqual(['Inbox/a.md']);
    expect(v.getAbstractFileByPath('Inbox')?.children).toEqual([]);
    expect(v.getAbstractFileByPath('b.md')).toBeNull();
  });
});

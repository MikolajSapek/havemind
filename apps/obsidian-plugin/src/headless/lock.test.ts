import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireLock } from './lock';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'hm-lock-'));
  dirs.push(d);
  return d;
};

describe('one process per agent (plan 014)', () => {
  it('takes over a lock an earlier container left with our own process id', async () => {
    // Process ids restart in every container: the old lock says "7", and so are we.
    const state = dir();
    writeFileSync(join(state, 'lock'), String(process.pid));
    expect(await acquireLock(state)).not.toBeNull();
    expect(readFileSync(join(state, 'lock'), 'utf8')).toContain(`${process.pid}:`);
  });

  it('refuses a lock this process already holds, and one a live process holds', async () => {
    const state = dir();
    const release = await acquireLock(state);
    expect(release).not.toBeNull();
    expect(await acquireLock(state)).toBeNull();
    await release?.();
    expect(await acquireLock(state)).not.toBeNull();

    const other = dir();
    writeFileSync(join(other, 'lock'), `${process.ppid}:sometoken`);
    expect(await acquireLock(other)).toBeNull();
  });

  it('takes over a lock whose process is gone', async () => {
    const state = dir();
    writeFileSync(join(state, 'lock'), '999999:gone');
    expect(await acquireLock(state)).not.toBeNull();
  });
});

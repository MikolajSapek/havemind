import { describe, expect, it } from 'vitest';

import { AgentPool } from './pool';

describe('the runner keeps agents open (plan 014)', () => {
  it('opens each agent once across passes, and again only after a drop', async () => {
    const opened: string[] = [];
    const released: string[] = [];
    const pool = new AgentPool(async (folder) => {
      opened.push(folder);
      return { agent: { folder }, release: async () => void released.push(folder) };
    });
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await pool.get('inbox-sorter')).toEqual({ folder: 'inbox-sorter' });
    }
    expect(opened).toEqual(['inbox-sorter']);
    await pool.drop('inbox-sorter');
    await pool.get('inbox-sorter');
    expect(opened).toEqual(['inbox-sorter', 'inbox-sorter']);
    await pool.closeAll();
    expect(released).toEqual(['inbox-sorter', 'inbox-sorter']);
  });

  it('skips an agent another process holds, and tries again next pass', async () => {
    let busy = true;
    const pool = new AgentPool(async () => (busy ? null : { agent: 1, release: async () => undefined }));
    expect(await pool.get('a')).toBeNull();
    busy = false;
    expect(await pool.get('a')).toBe(1);
  });
});

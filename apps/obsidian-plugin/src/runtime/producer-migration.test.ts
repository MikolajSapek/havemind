/**
 * A1: the 1.6.0 load imports the pre-1.6.0 `pushProducer` key into the sync
 * state. The fixture is the owner's Mac data.json as 1.5.9 left it (105 files),
 * with paths and hashes replaced; the shape, the ids and every relation between
 * the two stores are real.
 */

import { readFileSync } from 'node:fs';
import type { Plugin } from 'obsidian';
import { describe, expect, it } from 'vitest';

import { parseProducerStateResult } from './adapters/producer-state';
import { createPersistPort } from './obsidian-adapters';
import { DurableSyncState } from './sync-state';

const fixture = JSON.parse(
  readFileSync(new URL('../test/fixtures/data-json-1.5.9.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

function device(initial: Record<string, unknown>) {
  const disk = { value: structuredClone(initial), writes: 0 };
  const plugin = {
    loadData: async () => structuredClone(disk.value),
    saveData: async (data: Record<string, unknown>) => {
      disk.writes += 1;
      disk.value = structuredClone(data);
    },
  } as unknown as Plugin;
  return { disk, open: () => new DurableSyncState({ persist: createPersistPort(plugin) }) };
}

describe('producer migration from a real 1.5.9 data.json (A1)', () => {
  const legacy = parseProducerStateResult(fixture.pushProducer).state;

  it('moves every file and head into the sync state in one write, changing nothing else', async () => {
    const { disk, open } = device(fixture);
    expect(await open().loadProducer()).toEqual(legacy);
    expect(disk.writes).toBe(1);

    const { producer, ...rest } = disk.value.syncState as Record<string, unknown>;
    expect(producer).toEqual(legacy);
    expect(rest).toEqual(fixture.syncState);
    expect(disk.value['syncState.bak']).toEqual(fixture.syncState);
    expect(disk.value.pushProducer).toBeUndefined();
    expect(disk.value.clientInstanceId).toBe(fixture.clientInstanceId);
  });

  it('keeps every file where the apply side expects it', async () => {
    const { disk, open } = device(fixture);
    await open().loadCursor();
    const owners = (disk.value.syncState as { pathOwners: Record<string, string> }).pathOwners;
    expect(legacy.mappings).toHaveLength(105);
    for (const mapping of legacy.mappings) expect(owners[mapping.path]).toBe(mapping.fileId);
  });

  it('reads the migrated file on the next start without importing again', async () => {
    const { disk, open } = device(fixture);
    await open().loadCursor();
    const writes = disk.writes;
    expect(await open().loadProducer()).toEqual(legacy);
    expect(disk.writes).toBe(writes);
  });
});

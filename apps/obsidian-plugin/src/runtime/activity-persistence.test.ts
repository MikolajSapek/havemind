/**
 * Activity survives an Obsidian restart (plan 011, 1.1). The feed lived in
 * memory only, so every restart emptied it; now it is kept in the client
 * database's `activity` store, never in data.json.
 */
import { describe, expect, it } from 'vitest';

import { ActivityLog, type ActivityLogEntry } from './activity-log';
import { persistActivity, type ActivityRecords } from './activity-persistence';

const entry = (revisionId: string, timestamp: number): ActivityLogEntry => ({
  revisionId,
  fileId: `f-${revisionId}`,
  path: `Notes/${revisionId}.md`,
  kind: 'edit',
  author: { kind: 'member', membershipId: 'm1' },
  timestamp,
  hasContent: true,
});

function memoryRecords(initial?: unknown): ActivityRecords & { saved: unknown } {
  const box = { saved: initial };
  return {
    get saved() {
      return box.saved;
    },
    getActivityRecord: async () => box.saved,
    putActivityRecord: async (_key: string, value: unknown) => {
      box.saved = value;
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('persistActivity', () => {
  it('brings back what the last session recorded', async () => {
    const before = new ActivityLog();
    const records = memoryRecords();
    persistActivity(before, async () => records);
    await settle();
    before.record(entry('r1', 100));
    before.record(entry('r2', 200));
    await settle();

    const after = new ActivityLog();
    persistActivity(after, async () => records);
    await settle();
    expect(after.snapshot().map((e) => e.revisionId)).toEqual(['r1', 'r2']);
  });

  it('merges stored rows with ones recorded while the store was loading, oldest first, no duplicates', async () => {
    const records = memoryRecords({ format: 1, entries: [entry('r1', 100), entry('r2', 200)] });
    const log = new ActivityLog();
    log.record(entry('r3', 300));
    log.record(entry('r2', 250));
    persistActivity(log, async () => records);
    await settle();
    expect(log.snapshot().map((e) => [e.revisionId, e.timestamp])).toEqual([
      ['r1', 100],
      ['r2', 250],
      ['r3', 300],
    ]);
  });

  it('ignores a damaged record instead of failing', async () => {
    const log = new ActivityLog();
    persistActivity(log, async () => memoryRecords({ format: 1, entries: [{ nope: true }, entry('r1', 1)] }));
    await settle();
    expect(log.snapshot().map((e) => e.revisionId)).toEqual(['r1']);

    const garbage = new ActivityLog();
    persistActivity(garbage, async () => memoryRecords('not a record'));
    await settle();
    expect(garbage.snapshot()).toEqual([]);
  });

  it('keeps working in memory when the database cannot be opened', async () => {
    const log = new ActivityLog();
    persistActivity(log, async () => null);
    await settle();
    log.record(entry('r1', 1));
    expect(log.snapshot()).toHaveLength(1);
  });

  it('stops saving after it is disposed', async () => {
    const records = memoryRecords();
    const log = new ActivityLog();
    const dispose = persistActivity(log, async () => records);
    await settle();
    dispose();
    log.record(entry('r1', 1));
    await settle();
    expect(records.saved).toBeUndefined();
  });
});

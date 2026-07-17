import { describe, expect, it, vi } from 'vitest';

import {
  ActivityLog,
  activityEntriesToRecords,
  type ActivityLogEntry,
} from './activity-log';
import { buildActivityViewModel } from './activity-render';
import type { RosterMember } from './roster';

function entry(overrides: Partial<ActivityLogEntry> = {}): ActivityLogEntry {
  return {
    revisionId: 'rev-1',
    fileId: 'file-1',
    path: 'Notes/a.md',
    kind: 'edit',
    author: { kind: 'member', membershipId: 'm-owner' },
    timestamp: 100,
    hasContent: true,
    ...overrides,
  };
}

const roster: RosterMember[] = [
  { membershipId: 'm-owner', displayName: 'You', role: 'owner', self: true },
  { membershipId: 'm-magda', displayName: 'Magda', role: 'editor', self: false },
];

describe('ActivityLog', () => {
  it('records entries and returns them in a snapshot', () => {
    const log = new ActivityLog();
    log.record(entry({ revisionId: 'r1' }));
    log.record(entry({ revisionId: 'r2' }));
    expect(log.snapshot().map((e) => e.revisionId)).toEqual(['r1', 'r2']);
  });

  it('notifies subscribers on each record and stops after unsubscribe', () => {
    const log = new ActivityLog();
    const listener = vi.fn();
    const off = log.subscribe(listener);
    log.record(entry({ revisionId: 'r1' }));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    log.record(entry({ revisionId: 'r2' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates by revisionId, keeping the most recent record', () => {
    const log = new ActivityLog();
    log.record(entry({ revisionId: 'r1', kind: 'create' }));
    log.record(entry({ revisionId: 'r1', kind: 'edit', timestamp: 200 }));
    expect(log.snapshot()).toHaveLength(1);
    expect(log.snapshot()[0]?.kind).toBe('edit');
  });

  it('caps the log at maxEntries, dropping the oldest', () => {
    const log = new ActivityLog({ maxEntries: 2 });
    log.record(entry({ revisionId: 'r1' }));
    log.record(entry({ revisionId: 'r2' }));
    log.record(entry({ revisionId: 'r3' }));
    expect(log.snapshot().map((e) => e.revisionId)).toEqual(['r2', 'r3']);
  });
});

describe('activityEntriesToRecords', () => {
  it('renders entries with the author name, file and time from the fed stream', () => {
    const records = activityEntriesToRecords(
      [
        entry({
          revisionId: 'r1',
          path: 'Notes/owner.md',
          author: { kind: 'member', membershipId: 'm-owner' },
          timestamp: 100,
        }),
        entry({
          revisionId: 'r2',
          path: 'Notes/magda.md',
          author: { kind: 'member', membershipId: 'm-magda' },
          timestamp: 200,
        }),
      ],
      roster,
    );

    // Feed into the real view model so we assert what the Activity view shows.
    const model = buildActivityViewModel(records, {
      formatTimestamp: (ts) => `@${ts}`,
    });
    // Newest first: Magda's entry leads.
    expect(model.rows[0]?.label).toBe('edit · Notes/magda.md · Magda');
    expect(model.rows[0]?.timeLabel).toBe('@200');
    expect(model.rows[1]?.label).toBe('edit · Notes/owner.md · You');
  });

  it('attributes a remote revision to the sole other member (two-person pilot)', () => {
    const records = activityEntriesToRecords(
      [entry({ author: { kind: 'remote' } })],
      roster,
    );
    expect(records[0]?.actor).toMatchObject({
      kind: 'author',
      displayName: 'Magda',
    });
  });

  it('labels a remote revision neutrally when the other member is ambiguous', () => {
    const soloRoster: RosterMember[] = [
      { membershipId: 'm-owner', displayName: 'You', role: 'owner', self: true },
    ];
    const records = activityEntriesToRecords(
      [entry({ author: { kind: 'remote' } })],
      soloRoster,
    );
    expect(records[0]?.actor).toMatchObject({
      kind: 'author',
      displayName: 'Remote',
    });
  });

  it('marks a deletion as not restorable', () => {
    const records = activityEntriesToRecords(
      [entry({ kind: 'delete', hasContent: false })],
      roster,
    );
    expect(records[0]?.content).toBeNull();
  });

  it('falls back to a placeholder for an unknown membership without inventing a name', () => {
    const records = activityEntriesToRecords(
      [entry({ author: { kind: 'member', membershipId: 'm-ghost' } })],
      roster,
    );
    expect(records[0]?.actor).toMatchObject({
      kind: 'author',
      displayName: 'Unknown member',
    });
  });
});

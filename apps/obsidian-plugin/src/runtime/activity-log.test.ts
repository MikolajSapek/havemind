import { describe, expect, it, vi } from 'vitest';

import {
  ActivityLog,
  activityEntriesToRecords,
  remoteAppliedToActivityEntry,
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

  it('collapses a local push and its remote echo when both carry the same real revisionId', () => {
    // Regression: local entries used to be recorded under `operationId`, which
    // never matches the revisionId a remote echo of the SAME push carries, so
    // the two never collapsed into one row. With both keyed by the real
    // revisionId, the later remote echo replaces the local placeholder.
    const log = new ActivityLog();
    log.record(
      entry({
        revisionId: 'rev-shared',
        author: { kind: 'member', membershipId: 'm-owner' },
        timestamp: 100,
      }),
    );
    log.record(
      remoteAppliedToActivityEntry(
        { revisionId: 'rev-shared', fileId: 'file-1', path: 'Notes/a.md', operation: 'update' },
        200,
      ),
    );

    expect(log.snapshot()).toHaveLength(1);
    // The later record wins, here that happens to be the remote echo, which
    // is fine: the runner suppresses truly-local echoes before they ever
    // reach applyRemote, so in the live path only the local entry ever
    // records for a self-authored push.
    expect(log.snapshot()[0]).toMatchObject({ revisionId: 'rev-shared', timestamp: 200 });
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

describe('remoteAppliedToActivityEntry', () => {
  it('maps a genuinely applied remote revision to a remote-attributed entry', () => {
    const result = remoteAppliedToActivityEntry(
      { revisionId: 'rev-9', fileId: 'file-1', path: 'Notes/a.md', operation: 'update' },
      1000,
    );
    expect(result).toEqual({
      revisionId: 'rev-9',
      fileId: 'file-1',
      path: 'Notes/a.md',
      kind: 'edit',
      author: { kind: 'remote' },
      timestamp: 1000,
      hasContent: true,
    });
  });

  it('maps create/rename/delete operations to their matching kind', () => {
    expect(
      remoteAppliedToActivityEntry(
        { revisionId: 'r1', fileId: 'f1', path: 'a.md', operation: 'create' },
        1,
      ).kind,
    ).toBe('create');
    expect(
      remoteAppliedToActivityEntry(
        { revisionId: 'r2', fileId: 'f1', path: 'b.md', operation: 'rename' },
        1,
      ).kind,
    ).toBe('rename');
    expect(
      remoteAppliedToActivityEntry(
        { revisionId: 'r3', fileId: 'f1', path: 'b.md', operation: 'delete' },
        1,
      ),
    ).toMatchObject({ kind: 'delete', hasContent: false });
  });
});

describe('remote attribution with more than two members', () => {
  const roster: RosterMember[] = [
    { membershipId: 'm-you', displayName: 'You', role: 'owner', self: true },
    { membershipId: 'm-hubert', displayName: 'Hubert', role: 'editor', self: false },
    { membershipId: 'm-miki', displayName: 'Miki telfon', role: 'editor', self: false },
  ];

  it('names the author when the revision carries a membership id', () => {
    // The pull payload now surfaces the author, so a three-person vault
    // attributes precisely instead of falling back to "Remote". Before this,
    // soleOtherMember() returned null for any roster past two people and every
    // remote change in the feed read "Remote edit".
    const entry = remoteAppliedToActivityEntry(
      {
        revisionId: 'r1',
        fileId: 'f1',
        path: 'Notes/Kiln.md',
        operation: 'update',
        authorMembershipId: 'm-hubert',
      },
      1_000,
    );
    const records = activityEntriesToRecords([entry], roster);
    expect(records[0]?.actor).toEqual({
      kind: 'author',
      actorId: 'm-hubert',
      displayName: 'Hubert',
    });
  });

  it('stays neutral when the revision carries no author', () => {
    const entry = remoteAppliedToActivityEntry(
      { revisionId: 'r2', fileId: 'f2', path: 'Notes/Other.md', operation: 'update' },
      2_000,
    );
    const records = activityEntriesToRecords([entry], roster);
    expect(records[0]?.actor).toEqual({
      kind: 'author',
      actorId: expect.any(String),
      displayName: 'Remote',
    });
  });

  it('names an author the roster does not know yet', () => {
    // A member approved on another device is in the vault before this client
    // has seen them. Better an honest placeholder than someone else's name.
    const entry = remoteAppliedToActivityEntry(
      {
        revisionId: 'r3',
        fileId: 'f3',
        path: 'Notes/New.md',
        operation: 'update',
        authorMembershipId: 'm-unseen',
      },
      3_000,
    );
    const records = activityEntriesToRecords([entry], roster);
    expect(records[0]?.actor).toEqual({
      kind: 'author',
      actorId: 'm-unseen',
      displayName: 'Unknown member',
    });
  });
});

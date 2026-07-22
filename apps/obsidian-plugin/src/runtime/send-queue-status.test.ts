import { describe, expect, it } from 'vitest';

import {
  buildSendQueueStatus,
  selectNewlyQuarantined,
  type QuarantineViewEntry,
} from './send-queue-status';

const NOW = 1_000_000;

describe('buildSendQueueStatus', () => {
  it('counts only outbox items older than the staleness threshold', () => {
    const view = buildSendQueueStatus({
      outbox: [
        { revisionId: 'fresh', enqueuedAt: NOW - 5_000 },
        { revisionId: 'stale-1', enqueuedAt: NOW - 30_000 },
        { revisionId: 'stale-2', enqueuedAt: NOW - 120_000 },
      ],
      quarantine: [],
      now: NOW,
    });

    expect(view.waitingCount).toBe(2);
    expect(view.failed).toEqual([]);
  });

  it('reports zero waiting when every item is fresh', () => {
    const view = buildSendQueueStatus({
      outbox: [{ revisionId: 'a', enqueuedAt: NOW - 1_000 }],
      quarantine: [],
      now: NOW,
    });

    expect(view.waitingCount).toBe(0);
  });

  it('honours a custom staleness threshold', () => {
    const view = buildSendQueueStatus({
      outbox: [{ revisionId: 'a', enqueuedAt: NOW - 2_000 }],
      quarantine: [],
      now: NOW,
      staleThresholdMs: 1_000,
    });

    expect(view.waitingCount).toBe(1);
  });

  it('maps quarantine entries to failed rows labelled by path', () => {
    const quarantine: QuarantineViewEntry[] = [
      { revisionId: 'r1', fileId: 'f1', reason: 'server rejected', path: 'Notes/A.md' },
    ];
    const view = buildSendQueueStatus({ outbox: [], quarantine, now: NOW });

    expect(view.failed).toEqual([
      { revisionId: 'r1', label: 'Notes/A.md', reason: 'server rejected' },
    ]);
  });

  it('falls back to the fileId when no path is known', () => {
    const view = buildSendQueueStatus({
      outbox: [],
      quarantine: [{ revisionId: 'r1', fileId: 'file-42', reason: 'gone' }],
      now: NOW,
    });

    expect(view.failed[0]?.label).toBe('file-42');
  });

  it('falls back to a generic label when neither path nor fileId is known', () => {
    const view = buildSendQueueStatus({
      outbox: [],
      quarantine: [{ revisionId: 'r1', fileId: '', reason: 'gone' }],
      now: NOW,
    });

    expect(view.failed[0]?.label).toBe('Unknown change');
  });
});

describe('selectNewlyQuarantined', () => {
  it('returns every entry as fresh when nothing is known yet', () => {
    const quarantine: QuarantineViewEntry[] = [
      { revisionId: 'r1', fileId: 'f1', reason: 'x' },
      { revisionId: 'r2', fileId: 'f2', reason: 'y' },
    ];
    const { fresh, next } = selectNewlyQuarantined(new Set(), quarantine);

    expect(fresh.map((e) => e.revisionId)).toEqual(['r1', 'r2']);
    expect([...next].sort()).toEqual(['r1', 'r2']);
  });

  it('never re-announces an already-known quarantine (retry is silent)', () => {
    const known = new Set(['r1']);
    const quarantine: QuarantineViewEntry[] = [
      { revisionId: 'r1', fileId: 'f1', reason: 'x' },
      { revisionId: 'r2', fileId: 'f2', reason: 'y' },
    ];
    const { fresh, next } = selectNewlyQuarantined(known, quarantine);

    expect(fresh.map((e) => e.revisionId)).toEqual(['r2']);
    expect([...next].sort()).toEqual(['r1', 'r2']);
  });

  it('keeps a known id even after it leaves the quarantine (no re-fire on requeue back)', () => {
    const known = new Set(['r1']);
    const { fresh, next } = selectNewlyQuarantined(known, []);

    expect(fresh).toEqual([]);
    expect([...next]).toEqual(['r1']);
  });
});

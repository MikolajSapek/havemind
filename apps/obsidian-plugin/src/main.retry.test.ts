import { describe, expect, it } from 'vitest';

import { planQuarantineRequeueFallback, planRetryFromDisk } from './main';

describe('planRetryFromDisk (FINDING 1)', () => {
  it('keeps the row and asks to reconnect when the retry is unavailable (offline / disposed producer)', () => {
    // The COMMON durable-row case after a restart: the connection is null or the
    // producer's debouncer is disposed, so nothing was re-armed. A falsy result
    // must NOT be read as "file deleted", the change still needs to sync.
    for (const outcome of ['unavailable', undefined] as const) {
      expect(planRetryFromDisk(outcome, 'Notes/A.md', false)).toEqual({
        notice: 'Cannot retry while disconnected, reconnect first.',
        discard: false,
      });
      // Even a superseded server-rejected row (discardOnRetrigger) is kept when
      // the retry could not actually run.
      expect(planRetryFromDisk(outcome, 'Notes/A.md', true)).toEqual({
        notice: 'Cannot retry while disconnected, reconnect first.',
        discard: false,
      });
    }
  });

  it('discards with a Notice only when the file is confirmed missing', () => {
    expect(planRetryFromDisk('file-missing', 'Notes/Gone.md', false)).toEqual({
      notice: 'Notes/Gone.md no longer exists, removing it from the queue.',
      discard: true,
    });
  });

  it('re-triggers silently, keeping a failed-to-queue row until the commit lands', () => {
    expect(planRetryFromDisk('retriggered', 'Notes/A.md', false)).toEqual({
      notice: null,
      discard: false,
    });
  });

  it('re-triggers and drops a superseded server-rejected row when discardOnRetrigger is set', () => {
    expect(planRetryFromDisk('retriggered', 'Notes/A.md', true)).toEqual({
      notice: null,
      discard: true,
    });
  });
});

describe('planQuarantineRequeueFallback (FINDING 2)', () => {
  it('does nothing more when the stashed envelope re-queued', () => {
    expect(planQuarantineRequeueFallback(true, 'Notes/A.md')).toEqual({
      kind: 'requeued',
    });
  });

  it('falls back to a from-disk retry when requeue was inert but the path resolves', () => {
    expect(planQuarantineRequeueFallback(false, 'Notes/A.md')).toEqual({
      kind: 'retry-from-disk',
      path: 'Notes/A.md',
    });
  });

  it('discards the dead-letter row with a Notice when the fileId maps to no path', () => {
    // Evicted server-rejected row (byte-budget) whose fileId no longer resolves:
    // there is nothing to re-commit from disk, so surface a Notice and remove it
    // rather than leaving Retry a silent no-op.
    expect(planQuarantineRequeueFallback(false, null)).toEqual({
      kind: 'discard-dead-letter',
      notice: 'The original file for this change no longer exists, removing it.',
    });
  });
});

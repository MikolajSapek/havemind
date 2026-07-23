import { describe, expect, it } from 'vitest';

import { CommitPathRecovery, retryFailedCommit } from './commit-recovery';

function harness() {
  const notices: string[] = [];
  const rearmed: string[] = [];
  const failedToQueue: string[] = [];
  const cleared: string[] = [];
  const recovery = new CommitPathRecovery({
    notify: (message) => notices.push(message),
    rearm: (path) => rearmed.push(path),
    recordFailedToQueue: async (path) => {
      failedToQueue.push(path);
    },
    clearFailedToQueue: (path) => cleared.push(path),
  });
  return { recovery, notices, rearmed, failedToQueue, cleared };
}

describe('CommitPathRecovery (SND-02)', () => {
  it('surfaces a Notice and re-arms once on the first commit-path failure', async () => {
    const { recovery, notices, rearmed, failedToQueue } = harness();

    await recovery.onCommitFailure('Notes/A.md');

    expect(notices).toEqual([
      'A change to Notes/A.md could not be queued — will retry.',
    ]);
    expect(rearmed).toEqual(['Notes/A.md']);
    // Nothing durable yet — the re-arm gets one more chance.
    expect(failedToQueue).toEqual([]);
  });

  it('records a durable failed-to-queue entry on the second failure, without re-arming again', async () => {
    const { recovery, notices, rearmed, failedToQueue } = harness();

    await recovery.onCommitFailure('Notes/A.md'); // first: re-arm
    await recovery.onCommitFailure('Notes/A.md'); // retry also failed

    expect(rearmed).toEqual(['Notes/A.md']); // re-armed once only
    expect(failedToQueue).toEqual(['Notes/A.md']);
    expect(notices).toEqual([
      'A change to Notes/A.md could not be queued — will retry.',
      'A change to Notes/A.md could not be queued — see the Havemind panel.',
    ]);
  });

  it('resets the retry budget after a success, so a later failure re-arms again', async () => {
    const { recovery, rearmed, failedToQueue } = harness();

    await recovery.onCommitFailure('Notes/A.md'); // re-arm
    recovery.onCommitSuccess('Notes/A.md'); // the retry succeeded
    await recovery.onCommitFailure('Notes/A.md'); // a brand-new failure re-arms

    expect(rearmed).toEqual(['Notes/A.md', 'Notes/A.md']);
    expect(failedToQueue).toEqual([]);
  });

  it('tracks the retry budget per path independently', async () => {
    const { recovery, rearmed, failedToQueue } = harness();

    await recovery.onCommitFailure('Notes/A.md'); // A: re-arm
    await recovery.onCommitFailure('Notes/B.md'); // B: re-arm
    await recovery.onCommitFailure('Notes/A.md'); // A: durable

    expect(rearmed).toEqual(['Notes/A.md', 'Notes/B.md']);
    expect(failedToQueue).toEqual(['Notes/A.md']);
  });

  it('clears any durable failed-to-queue row for a path on commit success (MAJOR 1)', async () => {
    // A transient failure records a durable row; a later successful commit for
    // the same path (the user edits again and it goes through) must discard that
    // stale row — otherwise it survives forever as a phantom failure.
    const { recovery, cleared } = harness();

    await recovery.onCommitFailure('Notes/A.md'); // re-arm
    await recovery.onCommitFailure('Notes/A.md'); // durable row recorded
    recovery.onCommitSuccess('Notes/A.md'); // the next edit succeeds

    expect(cleared).toEqual(['Notes/A.md']);
  });
});

describe('retryFailedCommit (MAJOR 2)', () => {
  it('re-triggers the commit chain exactly once for a path that still exists', () => {
    const retriggered: string[] = [];
    const outcome = retryFailedCommit('Notes/A.md', {
      exists: () => true,
      retrigger: (path) => retriggered.push(path),
    });

    expect(outcome).toBe(true);
    expect(retriggered).toEqual(['Notes/A.md']);
  });

  it('does not re-trigger and reports missing when the path no longer exists', () => {
    const retriggered: string[] = [];
    const outcome = retryFailedCommit('Notes/Gone.md', {
      exists: () => false,
      retrigger: (path) => retriggered.push(path),
    });

    expect(outcome).toBe(false);
    expect(retriggered).toEqual([]);
  });
});

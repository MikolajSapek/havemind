import { describe, expect, it } from 'vitest';

import { CommitPathRecovery } from './commit-recovery';

function harness() {
  const notices: string[] = [];
  const rearmed: string[] = [];
  const failedToQueue: string[] = [];
  const recovery = new CommitPathRecovery({
    notify: (message) => notices.push(message),
    rearm: (path) => rearmed.push(path),
    recordFailedToQueue: async (path) => {
      failedToQueue.push(path);
    },
  });
  return { recovery, notices, rearmed, failedToQueue };
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
});

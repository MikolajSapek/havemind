/**
 * F8-01 — two-client end-to-end fault harness (T031).
 *
 * Each test drives two real clients against one real, opaque Fastify server and
 * asserts the exact reaction from the fault matrix in
 * `plan/07-pakiet-wdrozeniowy-i-e2e.md`. Rows, in table order:
 *
 *  1. Server restart mid-push        → no revision duplication (idempotency).
 *  2. Client restart mid-apply       → file materializes, no partial state.
 *  3. Two clients partitioned offline → converge, no accepted revision lost.
 *  4. Duplicate delivery (net retry) → server replays original, no 2nd revision.
 *  5. Restore onto clean instance    → new epoch forces reconciliation.
 *  6. Same-line conflict both clients → both heads kept, Conflicts/ entry, no
 *                                       silent loss.
 *
 * Hard rules under test (`plan/01`): the server stays opaque (it only stores
 * bytes and orders events) and there is never a silent overwrite.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { HarnessClient } from './harness/client.js';
import { cleanupHarnessDirectories, ServerHarness } from './harness/server.js';

const harnesses: ServerHarness[] = [];

async function makeHarness(): Promise<{
  server: ServerHarness;
  alice: HarnessClient;
  bob: HarnessClient;
}> {
  const server = await ServerHarness.create();
  harnesses.push(server);
  return {
    alice: new HarnessClient(server, server.alice),
    bob: new HarnessClient(server, server.bob),
    server,
  };
}

/** The non-conflict working file a client currently holds. */
function workingPath(client: HarnessClient): string {
  const path = client.paths().find((entry) => !entry.startsWith('Havemind'));
  if (path === undefined) {
    throw new Error('client has no working file');
  }
  return path;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (server) => server.close()));
  cleanupHarnessDirectories();
});

describe('F8-01 fault matrix — two clients against a real opaque server', () => {
  it('row 1: server restart mid-push does not duplicate the revision', async () => {
    const { server, alice } = await makeHarness();

    await alice.edit('note.md', 'first version\n');
    // Crash the client right after the server commits but before the receipt is
    // durably recorded — the classic double-commit hazard on restart.
    alice.failNextReceiptRecord();
    await alice.sync();

    expect(server.revisionCount()).toBe(1);
    expect(alice.outboxSize()).toBe(1);

    await server.restart();
    alice.restartRunner();
    await alice.sync();

    // The re-push replays the original commit; no second revision or event.
    expect(server.revisionCount()).toBe(1);
    expect(server.eventCount()).toBe(1);
    expect(alice.outboxSize()).toBe(0);
  });

  it('row 2: client restart mid-apply materializes the file with no partial state', async () => {
    const { alice, bob } = await makeHarness();

    await alice.edit('note.md', 'shared content\n');
    await alice.sync();

    // Bob crashes in the middle of applying the remote revision.
    bob.failNextApply();
    await bob.sync();
    expect(bob.paths()).toHaveLength(0);
    expect(bob.cursor()).toBe(0);

    bob.restartRunner();
    await bob.sync();

    expect(bob.cursor()).toBe(1);
    expect(bob.paths()).toHaveLength(1);
    expect(bob.read(workingPath(bob))).toBe('shared content\n');
  });

  it('row 3: two clients offline simultaneously converge without losing a revision', async () => {
    const { server, alice, bob } = await makeHarness();

    // Both edit distinct files entirely offline (no sync while "partitioned").
    await alice.edit('alice.md', 'alpha\n');
    await bob.edit('bob.md', 'beta\n');

    // Partition heals: drive cycles until both directions settle.
    await alice.sync();
    await bob.sync();
    await alice.sync();
    await bob.sync();

    expect(server.revisionCount()).toBe(2);
    expect(server.eventCount()).toBe(2);

    const aliceContents = alice.paths().map((path) => alice.read(path));
    const bobContents = bob.paths().map((path) => bob.read(path));
    expect(aliceContents).toContain('alpha\n');
    expect(aliceContents).toContain('beta\n');
    expect(bobContents).toContain('alpha\n');
    expect(bobContents).toContain('beta\n');
  });

  it('row 4: duplicate delivery replays the original result and adds no revision', async () => {
    const { server, alice } = await makeHarness();

    await alice.edit('note.md', 'only version\n');
    // First delivery reaches the server but the client never records it, so the
    // outbox re-delivers the identical batch on the next cycle (a network retry).
    alice.failNextReceiptRecord();
    await alice.sync();
    expect(server.revisionCount()).toBe(1);

    await alice.sync();
    const receipts = alice.lastPushReceipts();

    expect(server.revisionCount()).toBe(1);
    expect(server.eventCount()).toBe(1);
    expect(alice.outboxSize()).toBe(0);
    // The replayed receipt carries the original server sequence.
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.serverSequence).toBe(1);
  });

  it('row 5: restore onto a clean instance rotates the epoch and forces reconciliation', async () => {
    const { server, alice, bob } = await makeHarness();

    await alice.edit('note.md', 'durable content\n');
    await alice.sync();
    await bob.sync();
    expect(bob.read(workingPath(bob))).toBe('durable content\n');

    const oldEpoch = server.serverEpoch();
    const newEpoch = await server.restoreOntoCleanInstance();
    expect(newEpoch).not.toBe(oldEpoch);

    // Every client presenting its old cursor is forced to reconcile, then
    // re-materializes from the preserved history with nothing lost.
    await alice.sync();
    await bob.sync();

    expect(alice.sawEpochReconcile()).toBe(true);
    expect(bob.sawEpochReconcile()).toBe(true);
    expect(server.revisionCount()).toBe(1);
    expect(alice.read(workingPath(alice))).toBe('durable content\n');
    expect(bob.read(workingPath(bob))).toBe('durable content\n');
  });

  it('row 6: same-line conflict keeps both heads and records a visible conflict', async () => {
    const { server, alice, bob } = await makeHarness();

    // Establish a shared base revision on both clients.
    await alice.edit('shared.md', 'line one\n');
    await alice.sync();
    await bob.sync();
    const bobPath = workingPath(bob);
    expect(bob.read(bobPath)).toBe('line one\n');

    // Both open the file, then edit the same line divergently while concurrent.
    await alice.openEditor('shared.md');
    await bob.openEditor(bobPath);
    await alice.edit('shared.md', 'line one — alice\n');
    await bob.edit(bobPath, 'line one — bob\n');

    // Both push children of the same base, then each pulls the other's head.
    await alice.sync();
    await bob.sync();
    await alice.sync();

    const vaultId = server.alice.vaultId;
    const heads = server.heads(vaultId, headFileId(server, vaultId));
    expect(heads).toHaveLength(2); // both divergent heads preserved

    // Neither active buffer was silently overwritten.
    expect(alice.read('shared.md')).toBe('line one — alice\n');
    expect(bob.read(bobPath)).toBe('line one — bob\n');

    // Each divergence surfaced as a visible conflict artifact.
    expect(alice.conflictPaths().length).toBeGreaterThanOrEqual(1);
    expect(bob.conflictPaths().length).toBeGreaterThanOrEqual(1);
  });
});

/** The single fileId the shared vault holds (the conflict scenario has one). */
function headFileId(server: ServerHarness, vaultId: string): string {
  const fileId = server.fileIds(vaultId)[0];
  if (fileId === undefined) {
    throw new Error('vault has no file');
  }
  return fileId;
}

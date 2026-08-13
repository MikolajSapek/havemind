/**
 * F-config-semantic — two-device end-to-end coverage for the SEMANTIC half of the
 * `.obsidian/` appearance mirror: WHICH PART of a settings file crosses the wire,
 * and what happens when two devices change the same one.
 *
 * `config-mirror-two-device.test.ts` proves the bytes cross and
 * `config-apply-visibility-two-device.test.ts` proves the receiver notices. Both
 * assume the file is a whole-file copy — and for `.obsidian/graph.json` that
 * assumption was the field bug. Obsidian stores machine-local VIEW STATE in the
 * same file as the user's colour groups: merely OPENING the graph view rewrites
 * `scale` (the zoom) and the `collapse-*` panel folds. Every open produced a
 * revision, the two devices ping-ponged, each apply read as a divergence, and the
 * churn spawned `Havemind Conflicts/graph (conflict …).md` copies — a file
 * Obsidian never reads — while the one thing the user wanted synced (the colours)
 * never landed on the second device.
 *
 * These rows drive the real wire path (real observer, real config poller, real
 * outbox, real opaque server, real pull + decode) and pin the three properties
 * the fix rests on:
 *
 *  1. a rewrite that touched ONLY the volatile view state produces no revision at
 *     all — nothing reaches the server and nothing reaches the peer;
 *  2. a genuine `colorGroups` change lands on the peer AND the peer keeps its own
 *     zoom and fold state, and the merged write is not itself a change to push
 *     back (no echo, no ping-pong);
 *  3. divergent settings edits on both devices resolve by RECENCY — the newest
 *     write converges both — and nothing is ever deposited under
 *     `Havemind Conflicts/`.
 *
 * Production code under test: `sync/config-normalize.ts` through its real call
 * sites — `VaultChangeObserver` (hash/push side) and `mergeConfigContent` (apply
 * side).
 *
 * ─── DOCUMENTED GAP: the last-writer-wins DECISION itself ────────────────────
 * Row 3 proves the end state (recency wins, no conflict copy, no re-push) over
 * the real wire, but it cannot prove that the production apply adapter REFUSED to
 * write a conflict copy, because this harness does not instantiate
 * `VaultApplyAdapter`: it assembles the sync stack over harness-owned ports whose
 * apply path has no on-disk divergence guard of its own (`recordConflict` is
 * reached only from the runner's open-BUFFER guard, and Obsidian never opens a
 * hidden config file as an editor buffer). The branch-level decision —
 * `resolvesLastWriterWins`, every divergence branch it guards, and the untouched
 * conflict-copy behaviour for notes and attachments — is pinned in
 * `runtime/vault-apply.test.ts`; the volatile-key projection at the port is
 * pinned in `runtime/obsidian-adapters.test.ts`. What is genuinely end-to-end
 * here is everything between the two devices: what the producer pushes, what the
 * server orders, what the receiver writes, and what it pushes back.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { isSyncableConfigPath } from '@havemind/protocol';

import { HarnessClient } from './harness/client.js';
import { cleanupHarnessDirectories, ServerHarness } from './harness/server.js';

const GRAPH_PATH = '.obsidian/graph.json';

/** A recognisable colour group per device, so a mix-up cannot pass unnoticed. */
const ALICE_COLOURS = [{ query: 'tag:#work', color: { a: 1, rgb: 8087286 } }];
const BOB_COLOURS = [{ query: 'tag:#home', color: { a: 1, rgb: 16711680 } }];
const FINAL_COLOURS = [{ query: 'tag:#final', color: { a: 1, rgb: 255 } }];

/** Bob's own zoom and panel folds — machine-local, must survive every apply. */
const BOB_VIEW_STATE = {
  scale: 1.7391304347826086,
  close: true,
  'collapse-filter': true,
} as const;

/** Obsidian's own on-disk style for a settings file. */
function graphJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readGraph(client: HarnessClient): Record<string, unknown> {
  const raw = client.readConfig(GRAPH_PATH);
  if (raw === undefined) {
    throw new Error(`no ${GRAPH_PATH} on this device`);
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

interface TwoDevices {
  readonly server: ServerHarness;
  readonly alice: HarnessClient;
  readonly bob: HarnessClient;
}

const harnesses: ServerHarness[] = [];

async function makeHarness(): Promise<TwoDevices> {
  const server = await ServerHarness.create();
  harnesses.push(server);
  return {
    alice: new HarnessClient(server, server.alice),
    bob: new HarnessClient(server, server.bob),
    server,
  };
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (server) => server.close()));
  cleanupHarnessDirectories();
});

describe('F-config-semantic — graph.json syncs its settings, never the view state', () => {
  it('row 1: a zoom-only rewrite on device A reaches neither the server nor device B', async () => {
    const { server, alice, bob } = await makeHarness();

    // A shared starting point both devices agree on.
    await alice.writeConfig(
      GRAPH_PATH,
      graphJson({ colorGroups: ALICE_COLOURS, showTags: true, scale: 1 }),
    );
    expect(await alice.pollConfig()).toHaveLength(1);
    await alice.sync();
    expect(server.revisionCount()).toBe(1);
    await bob.sync();
    expect(readGraph(bob).colorGroups).toEqual(ALICE_COLOURS);
    const bobCursor = bob.cursor();

    // Alice merely OPENS the graph view and scrolls: Obsidian rewrites the file
    // with a new zoom and folded panels. Nothing the user chose has changed.
    await alice.writeConfig(
      GRAPH_PATH,
      graphJson({
        colorGroups: ALICE_COLOURS,
        showTags: true,
        scale: 2.7182818,
        close: true,
        'collapse-forces': true,
      }),
    );

    // The poll tick finds the file, hashes its SEMANTIC form, and sees no change:
    // no operation, nothing staged, nothing to push.
    expect(await alice.pollConfig()).toEqual([]);
    expect(alice.outboxSize()).toBe(0);
    await alice.sync();
    expect(server.revisionCount()).toBe(1);

    // And so device B is never woken, never advances its cursor, and never
    // applies a second revision for a file nobody edited.
    await bob.sync();
    expect(bob.cursor()).toBe(bobCursor);
    expect(bob.appliedRemote()).toHaveLength(1);
    expect(readGraph(bob).colorGroups).toEqual(ALICE_COLOURS);
  });

  it('row 2: a colour-group change lands on device B while B keeps its own zoom and folds', async () => {
    const { server, alice, bob } = await makeHarness();

    // Bob has been using the graph view on this machine, so Obsidian left HIS
    // zoom and panel folds on disk. Deliberately not polled: Obsidian fires no
    // vault event for a hidden file, so nothing has been staged from it yet.
    await bob.writeConfig(
      GRAPH_PATH,
      graphJson({ ...BOB_VIEW_STATE, colorGroups: [], showTags: false }),
    );

    // Alice picks her colour groups and adjusts the node size and a force slider —
    // all three are settings and all three must cross. Her own zoom and folds ride
    // along on disk and must not.
    await alice.writeConfig(
      GRAPH_PATH,
      graphJson({
        colorGroups: ALICE_COLOURS,
        showTags: true,
        nodeSizeMultiplier: 1.45,
        linkDistance: 250,
        scale: 9.5,
        'collapse-display': true,
      }),
    );
    expect(await alice.pollConfig()).toHaveLength(1);
    await alice.sync();
    expect(server.revisionCount()).toBe(1);

    await bob.sync();
    const merged = readGraph(bob);
    // Alice's settings landed — colours, sizes and forces alike…
    expect(merged.colorGroups).toEqual(ALICE_COLOURS);
    expect(merged.showTags).toBe(true);
    expect(merged.nodeSizeMultiplier).toBe(1.45);
    expect(merged.linkDistance).toBe(250);
    // …Bob's own view state survived the apply untouched…
    expect(merged.scale).toBe(BOB_VIEW_STATE.scale);
    expect(merged.close).toBe(true);
    expect(merged['collapse-filter']).toBe(true);
    // …and Alice's zoom and folds never crossed the wire at all.
    expect(merged.scale).not.toBe(9.5);
    expect(merged['collapse-display']).toBeUndefined();

    // The merged write is not a local change: re-reading it through the producer
    // yields exactly the revision just applied, so Bob pushes nothing back. This
    // is the ping-pong the fix removes.
    expect(await bob.pollConfig()).toEqual([]);
    await bob.sync();
    expect(server.revisionCount()).toBe(1);
    expect(bob.outboxSize()).toBe(0);
    expect(bob.conflictPaths()).toEqual([]);
  });

  it('row 3: divergent settings edits resolve by recency, with nothing in Havemind Conflicts', async () => {
    const { server, alice, bob } = await makeHarness();
    // The predicate the apply path's last-writer-wins branch keys on. A note is
    // deliberately outside it (see the DOCUMENTED GAP note above).
    expect(isSyncableConfigPath(GRAPH_PATH)).toBe(true);
    expect(isSyncableConfigPath('Notes/Plan.md')).toBe(false);

    // Both devices converge on a shared base first.
    await alice.writeConfig(
      GRAPH_PATH,
      graphJson({ colorGroups: [], showTags: true, scale: 1 }),
    );
    await alice.pollConfig();
    await alice.sync();
    await bob.sync();
    expect(readGraph(bob).colorGroups).toEqual([]);

    // Now both pick different colour groups before either has seen the other's —
    // a genuine concurrent divergence on a settings file.
    await alice.writeConfig(
      GRAPH_PATH,
      graphJson({ colorGroups: ALICE_COLOURS, showTags: true, scale: 1 }),
    );
    await bob.writeConfig(
      GRAPH_PATH,
      graphJson({ ...BOB_VIEW_STATE, colorGroups: BOB_COLOURS, showTags: true }),
    );
    expect(await alice.pollConfig()).toHaveLength(1);
    expect(await bob.pollConfig()).toHaveLength(1);

    // Two children of the same base reach the server, so the file has two
    // divergent heads — for a note this is exactly the shape that becomes a
    // conflict copy.
    await alice.sync();
    await bob.sync();
    const vaultId = server.alice.vaultId;
    const fileId = server.fileIds(vaultId)[0];
    if (fileId === undefined) throw new Error('vault has no file');
    expect(server.heads(vaultId, fileId)).toHaveLength(2);
    await alice.sync();

    // Each device adopted what the server's total order last handed it, so the
    // two settings files are stable but crossed — no copy, no overwrite loop.
    expect(alice.conflictPaths()).toEqual([]);
    expect(bob.conflictPaths()).toEqual([]);
    expect(await alice.pollConfig()).toEqual([]);
    expect(await bob.pollConfig()).toEqual([]);
    expect(server.revisionCount()).toBe(3);

    // The newest write settles it: whoever saved last wins on both devices.
    await alice.writeConfig(
      GRAPH_PATH,
      graphJson({ colorGroups: FINAL_COLOURS, showTags: false, scale: 3 }),
    );
    expect(await alice.pollConfig()).toHaveLength(1);
    await alice.sync();
    await bob.sync();

    expect(readGraph(alice).colorGroups).toEqual(FINAL_COLOURS);
    expect(readGraph(bob).colorGroups).toEqual(FINAL_COLOURS);
    expect(readGraph(alice).showTags).toBe(false);
    expect(readGraph(bob).showTags).toBe(false);
    // Bob's machine-local zoom survived every one of those applies.
    expect(readGraph(bob).scale).toBe(BOB_VIEW_STATE.scale);

    // Nothing was ever preserved as a conflict copy, on either device, and the
    // settings file is the only thing in the config tree.
    expect(alice.conflictPaths()).toEqual([]);
    expect(bob.conflictPaths()).toEqual([]);
    expect(alice.configPaths()).toEqual([GRAPH_PATH]);
    expect(bob.configPaths()).toEqual([GRAPH_PATH]);

    // Converged and quiet: neither device has anything left to push.
    expect(await alice.pollConfig()).toEqual([]);
    expect(await bob.pollConfig()).toEqual([]);
    expect(server.revisionCount()).toBe(4);
  });
});

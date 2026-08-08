/**
 * F-config — two-device end-to-end coverage for the `.obsidian/` APPEARANCE
 * mirror (theme CSS, snippets, hotkeys, appearance/app settings). Plugin code
 * and plugin state are OUTSIDE the allowlist and must never cross.
 *
 * The mirror is the one part of sync Obsidian gives no help with: hidden files
 * are never returned by `vault.getFiles()` and never fire a vault event, so the
 * only way a config change can be discovered is the production DataAdapter walk
 * (`listSyncableConfigPaths`) driven by the production poll tick
 * (`pollConfigOnce`). The harness therefore keeps the `.obsidian/` tree in a
 * store the vault file API cannot see (`HarnessClient.writeConfig` /
 * `readConfig`), exactly like the real app: if the walk or the poller stops
 * working, these tests fail rather than silently passing on paths a test
 * injected from above.
 *
 * Rows under test:
 *  1. A config file written behind the vault API's back reaches the peer and
 *     materialises at the SAME hidden path, byte-identical — and a steady-state
 *     poll on either device enqueues nothing (the content-hash cycle guard).
 *  2. Allowlist wins: a foreign plugin's CODE (`main.js`), its `data.json`, a
 *     theme's `data.json` and the per-machine `workspace.json` produce ZERO
 *     revisions and materialise nothing on the peer, while an allowlisted
 *     sibling in the same theme folder does sync — proving the walk descends
 *     there and the ALLOWLIST, not a blind spot, is what stops them.
 *  3. Fault variant: a config push interrupted by an offline transport backs
 *     off, and after recovery the revision lands EXACTLY ONCE — including when
 *     the receipt is lost and the identical batch is re-delivered.
 *
 * The second member is inserted straight into the shared vault (as
 * `fault-matrix.test.ts` does); the invitation/approval ceremony is covered by
 * `onboarding-two-device.test.ts` and is not what these rows are about.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { HarnessClient } from './harness/client.js';
import { cleanupHarnessDirectories, ServerHarness } from './harness/server.js';

const APPEARANCE_PATH = '.obsidian/appearance.json';
const PLUGIN_SECRET_PATH = '.obsidian/plugins/dataview/data.json';
const THEME_SECRET_PATH = '.obsidian/themes/Minimal/data.json';
const WORKSPACE_PATH = '.obsidian/workspace.json';
const PLUGIN_CODE_PATH = '.obsidian/plugins/dataview/main.js';
const PLUGIN_MANIFEST_PATH = '.obsidian/plugins/dataview/manifest.json';
const THEME_CSS_PATH = '.obsidian/themes/Minimal/theme.css';

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

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (server) => server.close()));
  cleanupHarnessDirectories();
});

describe('F-config `.obsidian/` mirror — two clients against a real opaque server', () => {
  it('row 1: a config file only the poller can see reaches the peer at the same hidden path, byte-identical, and settles', async () => {
    const { server, alice, bob } = await makeHarness();
    const appearance = '{\n  "accentColor": "#7b5cff",\n  "theme": "obsidian"\n}\n';

    // Obsidian fires NO vault event for a hidden file, so writing it queues
    // nothing on its own — the mirror is poll-driven by construction.
    await alice.writeConfig(APPEARANCE_PATH, appearance);
    expect(alice.outboxSize()).toBe(0);
    // And it is invisible to the vault file API (`getFiles()`), on both sides.
    expect(alice.paths()).toEqual([]);

    // One production poll tick discovers it through the DataAdapter walk and
    // stages a create through the SAME observer/outbox `.md` edits use.
    const ops = await alice.pollConfig();
    expect(ops.map((operation) => operation.path)).toEqual([APPEARANCE_PATH]);
    expect(ops.map((operation) => operation.kind)).toEqual(['create']);
    expect(alice.outboxSize()).toBe(1);

    await alice.sync();
    expect(server.revisionCount()).toBe(1);
    expect(alice.outboxSize()).toBe(0);

    // The peer materialises it at the identical hidden path with identical
    // bytes — through the DataAdapter, never as a visible vault file.
    await bob.sync();
    expect(bob.readConfig(APPEARANCE_PATH)).toBe(appearance);
    expect(bob.configPaths()).toEqual([APPEARANCE_PATH]);
    expect(bob.read(APPEARANCE_PATH)).toBeUndefined();
    expect(bob.paths()).toEqual([]);

    // Steady state (the cycle guard): the just-applied file hashes equal to the
    // adopted mapping, so the receiver's next poll enqueues nothing and no
    // second revision is ever authored — on either device.
    expect(await bob.pollConfig()).toEqual([]);
    expect(await alice.pollConfig()).toEqual([]);
    expect(bob.outboxSize()).toBe(0);
    expect(alice.outboxSize()).toBe(0);
    await bob.sync();
    await alice.sync();
    expect(server.revisionCount()).toBe(1);
    expect(server.eventCount()).toBe(1);

    // A later edit of the same config file is an update in place, not a fork.
    const recoloured = '{\n  "accentColor": "#00b894",\n  "theme": "obsidian"\n}\n';
    await alice.writeConfig(APPEARANCE_PATH, recoloured);
    const updates = await alice.pollConfig();
    expect(updates.map((operation) => operation.kind)).toEqual(['update']);
    await alice.sync();
    await bob.sync();
    expect(bob.readConfig(APPEARANCE_PATH)).toBe(recoloured);
    expect(bob.configPaths()).toEqual([APPEARANCE_PATH]);
    expect(server.revisionCount()).toBe(2);
  });

  it('row 2: foreign plugin CODE, plugin/theme `data.json` and per-machine `workspace.json` produce zero revisions and materialise nothing, while an allowlisted sibling in the same folder syncs', async () => {
    const { server, alice, bob } = await makeHarness();

    // Foreign plugin code (audit #3 finding 2 — the remote-code-execution
    // vector), secrets, and per-machine state, in the exact folders the walk
    // descends.
    await alice.writeConfig(PLUGIN_CODE_PATH, 'console.log("dataview");\n');
    await alice.writeConfig(PLUGIN_MANIFEST_PATH, '{"id":"dataview"}\n');
    await alice.writeConfig(PLUGIN_SECRET_PATH, '{"apiKey":"super-secret"}\n');
    await alice.writeConfig(THEME_SECRET_PATH, '{"licenceKey":"do-not-share"}\n');
    await alice.writeConfig(WORKSPACE_PATH, '{"main":{"id":"local-only"}}\n');

    // Nothing is even enqueued: the allowlist is evaluated inside the walk and
    // again in the producer guard, so no plugin file can reach the outbox.
    expect(await alice.pollConfig()).toEqual([]);
    expect(alice.outboxSize()).toBe(0);
    await alice.sync();
    expect(server.revisionCount()).toBe(0);
    expect(server.eventCount()).toBe(0);

    // The peer materialises nothing at all — no plugin code is ever written to
    // a peer's `.obsidian/plugins/` tree.
    await bob.sync();
    expect(bob.configPaths()).toEqual([]);
    expect(bob.paths()).toEqual([]);
    expect(bob.readConfig(PLUGIN_CODE_PATH)).toBeUndefined();
    expect(bob.readConfig(PLUGIN_MANIFEST_PATH)).toBeUndefined();
    expect(bob.readConfig(PLUGIN_SECRET_PATH)).toBeUndefined();
    expect(bob.readConfig(THEME_SECRET_PATH)).toBeUndefined();
    expect(bob.readConfig(WORKSPACE_PATH)).toBeUndefined();

    // Proof the walk genuinely reaches those folders (and that the rows above
    // are the ALLOWLIST working, not the enumeration never looking): an
    // allowlisted sibling next to the theme's secret does cross, and none of the
    // excluded files ever do.
    await alice.writeConfig(THEME_CSS_PATH, 'body { --accent: #7b5cff; }\n');
    const ops = await alice.pollConfig();
    expect(ops.map((operation) => operation.path)).toEqual([THEME_CSS_PATH]);

    await alice.sync();
    await bob.sync();
    expect(server.revisionCount()).toBe(1);
    expect(bob.configPaths()).toEqual([THEME_CSS_PATH]);
    expect(bob.readConfig(THEME_CSS_PATH)).toBe('body { --accent: #7b5cff; }\n');
    expect(bob.readConfig(PLUGIN_CODE_PATH)).toBeUndefined();
    expect(bob.readConfig(PLUGIN_MANIFEST_PATH)).toBeUndefined();
    expect(bob.readConfig(PLUGIN_SECRET_PATH)).toBeUndefined();
    expect(bob.readConfig(THEME_SECRET_PATH)).toBeUndefined();
    expect(bob.readConfig(WORKSPACE_PATH)).toBeUndefined();
  });

  it('row 3: a config push interrupted by an offline transport backs off, then lands exactly once after recovery', async () => {
    const { server, alice, bob } = await makeHarness();
    const hotkeys = '{\n  "editor:toggle-bold": [{ "key": "B" }]\n}\n';

    await alice.writeConfig('.obsidian/hotkeys.json', hotkeys);
    expect(await alice.pollConfig()).toHaveLength(1);
    expect(alice.outboxSize()).toBe(1);

    // The transport drops: the cycle reports offline and arms a backoff retry,
    // and the durable outbox keeps the revision.
    alice.goOffline();
    const offlineCycle = await alice.sync();
    expect(offlineCycle.status).toBe('offline');
    expect(alice.scheduledBackoffs()).toHaveLength(1);
    expect(server.revisionCount()).toBe(0);
    expect(alice.outboxSize()).toBe(1);

    // Polling again while offline must not duplicate the queued revision: the
    // content still hashes equal to the mapping the first poll adopted.
    expect(await alice.pollConfig()).toEqual([]);
    expect(alice.outboxSize()).toBe(1);

    // Recovery, with the receipt lost on the way back (the classic
    // double-commit hazard): the server commits, the client does not record it.
    alice.goOnline();
    alice.failNextReceiptRecord();
    await alice.sync();
    expect(server.revisionCount()).toBe(1);
    expect(alice.outboxSize()).toBe(1);

    // The outbox re-delivers the identical batch; the server replays the
    // original receipt, so the config file lands EXACTLY once.
    await alice.sync();
    expect(alice.outboxSize()).toBe(0);
    expect(server.revisionCount()).toBe(1);
    expect(server.eventCount()).toBe(1);
    expect(alice.lastPushReceipts()).toHaveLength(1);
    expect(alice.lastPushReceipts()[0]?.serverSequence).toBe(1);

    // A further cycle after full recovery adds nothing, and the peer ends up
    // with exactly one copy of the config file.
    await alice.sync();
    await bob.sync();
    expect(server.revisionCount()).toBe(1);
    expect(bob.configPaths()).toEqual(['.obsidian/hotkeys.json']);
    expect(bob.readConfig('.obsidian/hotkeys.json')).toBe(hotkeys);
    expect(bob.paths()).toEqual([]);
  });
});

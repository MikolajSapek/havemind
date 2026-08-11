/**
 * F-config-apply — two-device end-to-end coverage for the VISIBILITY half of the
 * `.obsidian/` appearance mirror: what the RECEIVING device does once the bytes
 * have landed.
 *
 * `config-mirror-two-device.test.ts` proves the bytes cross (allowlist, poll
 * tick, byte-identical materialisation). It stops there — and stopping there is
 * exactly the field bug: Obsidian caches its own config in memory, so a synced
 * snippet, theme or accent colour sat on disk and stayed invisible until the next
 * restart ("the graph colours did not change on the other device"). These rows
 * carry the same real path one step further and assert the EFFECT:
 *
 *  1. an allowlisted CSS-backed file (`.obsidian/snippets/…`, `themes/…`,
 *     `appearance.json`) refreshes the custom CSS on the receiver — one
 *     `css-change`, no toast;
 *  2. a settings file Obsidian has no live re-read signal for (`graph.json`,
 *     `hotkeys.json`, `app.json`, `core-plugins.json`) produces exactly one
 *     reload notice and never a bogus CSS refresh;
 *  3. a whole apply batch collapses to ONE of each effect, so a first full-mirror
 *     sync cannot bury the user under a dozen identical toasts;
 *  4. a snippet the peer DELETED also refreshes the CSS (otherwise it keeps
 *     styling this vault after it is gone);
 *  5. an ordinary markdown apply fires neither effect, and a device's OWN config
 *     write fires neither — only what arrives from a peer is refreshed.
 *
 * Production code under test: `classifyConfigApplyEffect` +
 * `createConfigApplyReloader` (`runtime/adapters/config-apply.ts`, re-exported
 * from `runtime/obsidian-adapters.ts`), driven by the real wire path — real
 * poller, real outbox, real opaque server, real pull + decode. HARNESS GLUE, so
 * it is on the record: the live plugin notifies the reloader from
 * `createVaultFilePort`'s `.obsidian/` branch (write/delete), and that port needs
 * a live Obsidian `Vault` with a DataAdapter, which this harness does not model;
 * the harness therefore notifies it at the SAME point in its own apply path, with
 * the same argument. The port-side call site is unit-tested in
 * `runtime/obsidian-adapters.test.ts`; the classification, the batching and the
 * "did it reach the peer at all" chain are genuinely end-to-end here.
 *
 * ─── DOCUMENTED GAP: the command-palette actions (sync-now / disconnect /
 * reset-connection) ────────────────────────────────────────────────────────────
 * Not covered here, and deliberately not forced. The e2e harness does not
 * instantiate `HavemindPlugin` at all — it assembles the sync stack (observer,
 * poller, outbox, `SyncRunner`, apply path) directly over harness-owned ports.
 * Driving those three commands END-TO-END (as opposed to the existing unit
 * coverage in `main.commands.test.ts` and `main.connection-reset.test.ts`, which
 * pin ids, availability guards and state transitions against a stubbed
 * connection) would need a plugin-runtime harness that does not exist yet:
 *   - `requestUrl` overridden on the aliased `obsidian` module so the plugin's
 *     own transport reaches the Fastify app (the inject bridge already exists in
 *     `onboarding-two-device.test.ts` as `injectRequestUrl`);
 *   - a Vault double mounted on the mock `App` (the shared mock's `app.vault` is
 *     a counter stub with no file API, `adapter` or `on()`), rich enough for
 *     `createVaultFilePort` and the push producer;
 *   - a persisted owner-connection blob in the plugin-data store that
 *     `parseOwnerConnection`/`gateOwnerConnection` accept, so `startConnection()`
 *     builds a real loop that `disconnect()` can then tear down and
 *     `resetConnection()` can clear.
 * Without those, an "e2e" command test would touch no server and assert nothing
 * the unit tests do not already assert, so it is left out rather than padded in.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyConfigApplyEffect,
  CONFIG_RELOAD_NOTICE,
  createConfigApplyReloader,
  type ConfigApplyReloader,
} from '../../apps/obsidian-plugin/src/runtime/obsidian-adapters.js';

import { HarnessClient } from './harness/client.js';
import { cleanupHarnessDirectories, ServerHarness } from './harness/server.js';

const SNIPPET_PATH = '.obsidian/snippets/test.css';
const THEME_CSS_PATH = '.obsidian/themes/Minimal/theme.css';
const APPEARANCE_PATH = '.obsidian/appearance.json';
const GRAPH_PATH = '.obsidian/graph.json';
const HOTKEYS_PATH = '.obsidian/hotkeys.json';

const SNIPPET_CSS = '.markdown-preview-view { --accent: #7b5cff; }\n';

/**
 * The production reloader with its three seams captured. The timer seam records
 * the armed batch instead of firing it, so a row can prove the effects are
 * genuinely BATCHED (nothing fires mid-apply) and then flush once.
 */
interface ConfigApplyProbe {
  readonly reloader: ConfigApplyReloader;
  cssChanges(): number;
  notices(): readonly string[];
  /** Batches armed but not yet flushed. */
  armedBatches(): number;
  /** Fires every armed batch, as `window.setTimeout` would. */
  flush(): void;
}

function configApplyProbe(): ConfigApplyProbe {
  let cssChanges = 0;
  const notices: string[] = [];
  const armed: Array<() => void> = [];
  const reloader = createConfigApplyReloader({
    triggerCssChange: () => {
      cssChanges += 1;
    },
    notify: (message) => {
      notices.push(message);
    },
    schedule: (run) => {
      armed.push(run);
    },
  });
  return {
    armedBatches: () => armed.length,
    cssChanges: () => cssChanges,
    flush: () => {
      for (const run of armed.splice(0)) run();
    },
    notices: () => [...notices],
    reloader,
  };
}

interface TwoDevices {
  readonly server: ServerHarness;
  readonly alice: HarnessClient;
  readonly bob: HarnessClient;
  readonly aliceEffects: ConfigApplyProbe;
  readonly bobEffects: ConfigApplyProbe;
}

const harnesses: ServerHarness[] = [];

async function makeHarness(): Promise<TwoDevices> {
  const server = await ServerHarness.create();
  harnesses.push(server);
  const aliceEffects = configApplyProbe();
  const bobEffects = configApplyProbe();
  return {
    alice: new HarnessClient(server, server.alice, {
      configApply: aliceEffects.reloader,
    }),
    aliceEffects,
    bob: new HarnessClient(server, server.bob, {
      configApply: bobEffects.reloader,
    }),
    bobEffects,
    server,
  };
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (server) => server.close()));
  cleanupHarnessDirectories();
});

describe('F-config-apply — a received `.obsidian/` change becomes visible on the peer', () => {
  it('row 1: a snippet written on device A lands byte-identical on B and refreshes the custom CSS exactly once, with no toast', async () => {
    const { server, alice, bob, aliceEffects, bobEffects } = await makeHarness();

    await alice.writeConfig(SNIPPET_PATH, SNIPPET_CSS);
    expect(await alice.pollConfig()).toHaveLength(1);
    await alice.sync();
    expect(server.revisionCount()).toBe(1);

    // The author refreshes nothing: Obsidian made this change itself and already
    // knows about it. Only an APPLIED (received) config change needs the signal.
    expect(aliceEffects.cssChanges()).toBe(0);
    expect(aliceEffects.armedBatches()).toBe(0);

    await bob.sync();
    expect(bob.readConfig(SNIPPET_PATH)).toBe(SNIPPET_CSS);

    // Batched, not fired inline: the apply path armed exactly one window and
    // nothing has happened yet.
    expect(bobEffects.armedBatches()).toBe(1);
    expect(bobEffects.cssChanges()).toBe(0);

    bobEffects.flush();
    expect(bobEffects.cssChanges()).toBe(1);
    // A snippet applies in place — the user is never told to restart for one.
    expect(bobEffects.notices()).toEqual([]);
    expect(classifyConfigApplyEffect(SNIPPET_PATH)).toBe('css-reload');
  });

  it('row 2: a graph-settings change Obsidian cannot re-read in place produces one honest reload notice and no CSS refresh', async () => {
    const { alice, bob, bobEffects } = await makeHarness();
    const graph = '{\n  "colorGroups": [{ "color": { "rgb": 8087286 } }]\n}\n';

    await alice.writeConfig(GRAPH_PATH, graph);
    expect(await alice.pollConfig()).toHaveLength(1);
    await alice.sync();

    await bob.sync();
    expect(bob.readConfig(GRAPH_PATH)).toBe(graph);

    bobEffects.flush();
    // Exactly the message the user sees, once — and no CSS refresh pretending
    // graph settings re-read themselves.
    expect(bobEffects.notices()).toEqual([CONFIG_RELOAD_NOTICE]);
    expect(bobEffects.cssChanges()).toBe(0);
    expect(classifyConfigApplyEffect(GRAPH_PATH)).toBe('reload-notice');
  });

  it('row 3: a whole appearance batch collapses to one CSS refresh and one notice', async () => {
    const { server, alice, bob, bobEffects } = await makeHarness();

    await alice.writeConfig(SNIPPET_PATH, SNIPPET_CSS);
    await alice.writeConfig(THEME_CSS_PATH, 'body { --h1: 2rem; }\n');
    await alice.writeConfig(APPEARANCE_PATH, '{\n  "accentColor": "#7b5cff"\n}\n');
    await alice.writeConfig(HOTKEYS_PATH, '{\n  "editor:toggle-bold": []\n}\n');

    // One poll tick discovers all four; one push carries all four.
    expect(await alice.pollConfig()).toHaveLength(4);
    await alice.sync();
    expect(server.revisionCount()).toBe(4);

    // Four applies, ONE armed batch — the window is armed by the first path and
    // never re-armed or extended by the rest.
    await bob.sync();
    expect(bob.configPaths()).toEqual(
      [APPEARANCE_PATH, HOTKEYS_PATH, SNIPPET_PATH, THEME_CSS_PATH].sort(),
    );
    expect(bobEffects.armedBatches()).toBe(1);

    bobEffects.flush();
    // Three CSS-backed files → ONE css-change. One reload-only file → ONE toast.
    expect(bobEffects.cssChanges()).toBe(1);
    expect(bobEffects.notices()).toEqual([CONFIG_RELOAD_NOTICE]);
    expect(
      [SNIPPET_PATH, THEME_CSS_PATH, APPEARANCE_PATH, HOTKEYS_PATH].map(
        classifyConfigApplyEffect,
      ),
    ).toEqual(['css-reload', 'css-reload', 'css-reload', 'reload-notice']);
  });

  it('row 4: a snippet the peer deleted disappears and still refreshes the CSS', async () => {
    const { alice, bob, bobEffects } = await makeHarness();

    await alice.writeConfig(SNIPPET_PATH, SNIPPET_CSS);
    await alice.pollConfig();
    await alice.sync();
    await bob.sync();
    expect(bob.readConfig(SNIPPET_PATH)).toBe(SNIPPET_CSS);
    bobEffects.flush();
    expect(bobEffects.cssChanges()).toBe(1);

    // The author removes the snippet; the poller tombstones it from the mapping.
    await alice.deleteConfig(SNIPPET_PATH);
    const deletes = await alice.pollConfig();
    expect(deletes.map((operation) => operation.kind)).toEqual(['delete']);
    await alice.sync();

    await bob.sync();
    expect(bob.readConfig(SNIPPET_PATH)).toBeUndefined();
    expect(bob.configPaths()).toEqual([]);

    // A removal is the same visibility problem in reverse: without the refresh
    // the deleted snippet keeps styling this vault.
    bobEffects.flush();
    expect(bobEffects.cssChanges()).toBe(2);
    expect(bobEffects.notices()).toEqual([]);
  });

  it('row 5: an ordinary markdown apply fires no config effect at all', async () => {
    const { alice, bob, bobEffects } = await makeHarness();

    await alice.edit('Notes/Plan.md', 'Shared plan\n');
    await alice.sync();

    await bob.sync();
    expect(bob.read('Notes/Plan.md')).toBe('Shared plan\n');

    // No batch was ever armed, so a note sync can never trigger a CSS refresh or
    // tell the user to reload Obsidian.
    expect(bobEffects.armedBatches()).toBe(0);
    bobEffects.flush();
    expect(bobEffects.cssChanges()).toBe(0);
    expect(bobEffects.notices()).toEqual([]);
  });
});

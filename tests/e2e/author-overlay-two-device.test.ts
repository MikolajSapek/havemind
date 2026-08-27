/**
 * F6-authorship, two-device end-to-end coverage for the AUTHOR OVERLAY's data
 * path: after a device applies a peer's revision, does the overlay name the right
 * person for that exact file?
 *
 * The overlay is honest-by-construction and that is precisely what needs an
 * end-to-end check. The claim it makes is per FILE ("this note was last changed
 * by X at T", see `attribution/overlay-source.ts`), resolved from the Activity
 * feed, whose remote entries carry NO author id, the pull stream has none, so a
 * remote revision is attributed to the sole other roster member (the two-person
 * pilot) by `activityEntriesToRecords`. Three separate modules therefore have to
 * agree about one path, and until now nothing checked them against a revision that
 * had actually travelled through a server.
 *
 * Every step below the test is production code: the real poller-free note path
 * (observer + reconciliation + outbox), the real opaque server, the real pull +
 * payload decode, then `remoteAppliedToActivityEntryOrNull` → `ActivityLog` →
 * `activityEntriesToRecords` → `buildFileOverlayInput` → `buildLivePreviewOverlay`.
 * The path, fileId and revisionId fed into that chain are the ones the receiving
 * device genuinely decoded from the server's relayed payload, never test
 * literals.
 *
 * HARNESS GLUE, on the record:
 *  - the `bootstrap` vs `live` origin of an applied revision is decided by the
 *    production `VaultApplyAdapter`, which this harness does not run, so the
 *    tests pass `origin: 'live'` explicitly (the collapse-bootstrap-to-silence
 *    branch is unit-tested in `runtime/activity-log.test.ts`);
 *  - the wall-clock timestamp is supplied by the runtime in production; here each
 *    applied revision gets a monotonically increasing stamp, which is what makes
 *    the "newest revision for the path wins" row meaningful.
 *
 * Rows:
 *  1. B applies A's note → the overlay names A, for that path only, over the whole
 *     document.
 *  2. A path with nothing recorded, and the toggle switched off, draw nothing
 *     rather than guessing.
 *  3. A second revision for the same path wins: the overlay follows the newest
 *     applied revision, not the first.
 *  4. Two files, two authors: each device attributes each path to whoever sent it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { buildLivePreviewOverlay } from '../../apps/obsidian-plugin/src/attribution/attribution.js';
import { buildFileOverlayInput } from '../../apps/obsidian-plugin/src/attribution/overlay-source.js';
import {
  ActivityLog,
  remoteAppliedToActivityEntryOrNull,
} from '../../apps/obsidian-plugin/src/runtime/activity-log.js';
import { authorColorToken } from '../../apps/obsidian-plugin/src/runtime/author-colors.js';
import type { RosterMember } from '../../apps/obsidian-plugin/src/runtime/roster.js';

import { HarnessClient } from './harness/client.js';
import { cleanupHarnessDirectories, ServerHarness } from './harness/server.js';

const NOTE_PATH = 'Notes/Plan.md';
const OTHER_NOTE_PATH = 'Notes/Retro.md';

const harnesses: ServerHarness[] = [];

interface TwoDevices {
  readonly server: ServerHarness;
  readonly alice: HarnessClient;
  readonly bob: HarnessClient;
  /** Alice's roster: herself plus Bob. */
  readonly aliceRoster: readonly RosterMember[];
  /** Bob's roster: himself plus Alice. */
  readonly bobRoster: readonly RosterMember[];
}

async function makeHarness(): Promise<TwoDevices> {
  const server = await ServerHarness.create();
  harnesses.push(server);
  const aliceMember: RosterMember = {
    displayName: 'Alice',
    membershipId: server.alice.membershipId,
    role: 'owner',
    self: true,
  };
  const bobMember: RosterMember = {
    displayName: 'Bob',
    membershipId: server.bob.membershipId,
    role: 'editor',
    self: true,
  };
  return {
    alice: new HarnessClient(server, server.alice),
    aliceRoster: [aliceMember, { ...bobMember, self: false }],
    bob: new HarnessClient(server, server.bob),
    bobRoster: [bobMember, { ...aliceMember, self: false }],
    server,
  };
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (server) => server.close()));
  cleanupHarnessDirectories();
});

/**
 * Feeds everything this device has applied from the peer into a real
 * `ActivityLog` through the production mapper, exactly as the runtime does on the
 * apply path, see the harness-glue note in the module docstring for the two
 * values the runtime owns and the test therefore supplies.
 */
function activityFromApplies(client: HarnessClient): ActivityLog {
  const log = new ActivityLog();
  client.appliedRemote().forEach((info, index) => {
    const entry = remoteAppliedToActivityEntryOrNull(
      { ...info, origin: 'live' },
      1_000 + index,
    );
    if (entry !== null) log.record(entry);
  });
  return log;
}

/** The overlay a device would draw for one open file, or null for silence. */
function overlayFor(
  client: HarnessClient,
  roster: readonly RosterMember[],
  path: string,
  options: { readonly enabled?: boolean } = {},
): ReturnType<typeof buildLivePreviewOverlay> | null {
  const content = client.read(path) ?? '';
  const input = buildFileOverlayInput({
    content,
    enabled: options.enabled ?? true,
    entries: activityFromApplies(client).snapshot(),
    path,
    reducedMotion: false,
    roster,
  });
  return input === null ? null : buildLivePreviewOverlay(input);
}

describe('F6-authorship, the author overlay over a revision that really crossed the wire', () => {
  it('row 1: after B applies A’s note, the overlay names A across the whole document', async () => {
    const { server, alice, bob, bobRoster } = await makeHarness();
    const content = 'Shared plan\n\nSecond paragraph\n';

    await alice.edit(NOTE_PATH, content);
    await alice.sync();
    expect(server.revisionCount()).toBe(1);

    await bob.sync();
    expect(bob.read(NOTE_PATH)).toBe(content);

    // The applied facts come from the decoded payload, not from the test.
    const applied = bob.appliedRemote();
    expect(applied.map((info) => info.path)).toEqual([NOTE_PATH]);
    expect(applied.map((info) => info.operation)).toEqual(['create']);

    const overlay = overlayFor(bob, bobRoster, NOTE_PATH);
    expect(overlay?.visible).toBe(true);
    expect(overlay?.segments).toHaveLength(1);
    const segment = overlay?.segments[0];
    // Whole-file attribution: one run covering every character, never a
    // per-line claim the client cannot back up.
    expect(segment?.from).toBe(0);
    expect(segment?.to).toBe(content.length);
    expect(segment?.author.displayName).toBe('Alice');
    expect(segment?.author.actorId).toBe(server.alice.membershipId);
    expect(segment?.author.kind).toBe('author');
    // Colour is never the only signal.
    expect(segment?.underline).toBe(true);
    expect(segment?.tooltip).toContain('Alice');
    expect(overlay?.legend.map((entry) => entry.label)).toEqual(['Alice']);
  });

  it('row 2: a path with nothing recorded, and a switched-off toggle, both draw nothing', async () => {
    const { alice, bob, bobRoster, aliceRoster } = await makeHarness();

    await alice.edit(NOTE_PATH, 'Shared plan\n');
    await alice.sync();
    await bob.sync();

    // A file B wrote itself has no APPLIED revision, so the overlay stays silent
    // rather than attributing it to whoever happens to be in the roster.
    await bob.edit(OTHER_NOTE_PATH, 'Bob thinking out loud\n');
    expect(overlayFor(bob, bobRoster, OTHER_NOTE_PATH)).toBeNull();

    // Nor does A, which applied nothing at all, attribute its own note.
    expect(overlayFor(alice, aliceRoster, NOTE_PATH)).toBeNull();

    // And the toggle is respected even where there IS something to say.
    expect(overlayFor(bob, bobRoster, NOTE_PATH, { enabled: false })).toBeNull();
    expect(overlayFor(bob, bobRoster, NOTE_PATH)?.visible).toBe(true);
  });

  it('row 3: a second revision for the same path wins over the first', async () => {
    const { server, alice, bob, bobRoster } = await makeHarness();

    await alice.edit(NOTE_PATH, 'First draft\n');
    await alice.sync();
    await bob.sync();
    const first = bob.appliedRemote().at(-1)?.revisionId;

    const revised = 'First draft, revised again\n';
    await alice.edit(NOTE_PATH, revised);
    await alice.sync();
    await bob.sync();
    expect(bob.read(NOTE_PATH)).toBe(revised);
    expect(server.revisionCount()).toBe(2);

    const applied = bob.appliedRemote();
    expect(applied).toHaveLength(2);
    expect(applied.map((info) => info.operation)).toEqual(['create', 'update']);
    const second = applied.at(-1)?.revisionId;
    expect(second).not.toBe(first);

    // Both revisions are recorded for the path; the overlay must follow the
    // NEWEST one, and its run must cover the revised (longer) document.
    const input = buildFileOverlayInput({
      content: revised,
      enabled: true,
      entries: activityFromApplies(bob).snapshot(),
      path: NOTE_PATH,
      reducedMotion: false,
      roster: bobRoster,
    });
    expect([...(input?.authors.keys() ?? [])]).toEqual([second]);
    expect(input?.provenance.map((run) => run.length)).toEqual([revised.length]);
    expect(input?.authors.get(second ?? '')?.timestamp).toBe(1_001);

    const overlay = overlayFor(bob, bobRoster, NOTE_PATH);
    expect(overlay?.segments[0]?.to).toBe(revised.length);
    expect(overlay?.segments[0]?.author.displayName).toBe('Alice');
  });

  it('row 4: two notes, two authors, each device attributes each path to whoever sent it', async () => {
    const { server, alice, bob, aliceRoster, bobRoster } = await makeHarness();

    await alice.edit(NOTE_PATH, 'Alice plan\n');
    await alice.sync();
    await bob.edit(OTHER_NOTE_PATH, 'Bob retro\n');
    await bob.sync();
    // Both devices now hold both notes.
    await alice.sync();
    expect(server.revisionCount()).toBe(2);
    expect(alice.paths()).toEqual([NOTE_PATH, OTHER_NOTE_PATH].sort());
    expect(bob.paths()).toEqual([NOTE_PATH, OTHER_NOTE_PATH].sort());

    // On B: the note that arrived is Alice's; the note B authored says nothing.
    expect(overlayFor(bob, bobRoster, NOTE_PATH)?.segments[0]?.author.displayName).toBe(
      'Alice',
    );
    expect(overlayFor(bob, bobRoster, OTHER_NOTE_PATH)).toBeNull();

    // On A: mirror image, the arrived note is Bob's, its own note is silent.
    const arrived = overlayFor(alice, aliceRoster, OTHER_NOTE_PATH);
    expect(arrived?.segments[0]?.author.displayName).toBe('Bob');
    expect(arrived?.segments[0]?.author.actorId).toBe(server.bob.membershipId);
    expect(overlayFor(alice, aliceRoster, NOTE_PATH)).toBeNull();

    // Each author is drawn in the colour the roster and the Activity rows draw
    // them in, one shared, id-keyed source of truth, never a per-surface guess.
    expect(overlayFor(bob, bobRoster, NOTE_PATH)?.segments[0]?.colorToken).toBe(
      authorColorToken(server.alice.membershipId),
    );
    expect(arrived?.segments[0]?.colorToken).toBe(
      authorColorToken(server.bob.membershipId),
    );
  });
});

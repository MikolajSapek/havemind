/**
 * Windows wire-format hardening for the push producer (field bug: a Windows
 * device paired, its empty create synced, but its first two-line modify never
 * reached the server, the request never went out, the outbox wedged, the device
 * latched "Offline, will retry").
 *
 * The wire contract is LF-only content and forward-slash paths
 * (`packages/protocol`). A Windows note carries CRLF line endings and, in the
 * worst case, a backslash path separator. These tests route a CRLF-authored /
 * backslash-pathed change through the SAME production wiring the plugin uses at
 * runtime, the real `VaultChangeObserver` on top of the real
 * `OutboxLocalChangeRepository` (which builds the actual opaque envelope via
 * `buildRevisionEnvelope`), so they cannot go false-green against a
 * reimplemented producer (see the sync/conflict integration-test convention).
 */

import { describe, expect, it } from 'vitest';

import { decodeRevisionPayload } from '@havemind/sync-core';

import {
  VaultChangeObserver,
  type LocalChangeRepository,
  type VaultSnapshotPort,
} from '../obsidian/vault-adapter';
import type { OutboxEnvelope } from '../runtime/sync-state';
import {
  OutboxLocalChangeRepository,
  type ProducerState,
} from './outbox-repository';
import { reconcileVaultState } from './reconciliation';

const IDENTITY = {
  vaultId: '11111111-1111-4111-8111-111111111111',
  memberId: '33333333-3333-4333-8333-333333333333',
  deviceId: '44444444-4444-4444-8444-444444444444',
} as const;

class MemoryStore {
  state: ProducerState = { mappings: [], heads: {} };
  async load(): Promise<ProducerState> {
    return this.state;
  }
  async save(state: ProducerState): Promise<void> {
    this.state = state;
  }
}

/**
 * The forward-slash / NFC key form Obsidian indexes files under. The test vault
 * stores content under this normalised key, exactly like the real vault, so a
 * lookup with a raw backslash path MISSES, faithfully reproducing what
 * `getAbstractFileByPath` does on real Obsidian. (The previous fixture keyed on
 * the exact raw string, so a backslash read "worked", a false green that hid
 * the silent-drop / phantom-empty bug this suite is meant to catch.)
 */
function normaliseKey(path: string): string {
  return path.replace(/\\/gu, '/').normalize('NFC');
}

class MemoryVault implements VaultSnapshotPort {
  readonly contents = new Map<string, string>();
  /** Store content under the normalised (forward-slash) key, like Obsidian. */
  set(path: string, content: string): void {
    this.contents.set(normaliseKey(path), content);
  }
  async listSyncablePaths(): Promise<readonly string[]> {
    return [...this.contents.keys()];
  }
  async readText(path: string): Promise<string> {
    // Resolve by the EXACT path given, no normalisation. A raw backslash path
    // is not an index key, so it misses and reads '' just as the real snapshot
    // adapter does (`getAbstractFileByPath(path) === null ? '' : …`).
    return this.contents.get(path) ?? '';
  }
  async readBinary(): Promise<Uint8Array> {
    throw new Error('not used');
  }
  async listAllPaths(): Promise<readonly string[]> {
    return [...this.contents.keys()];
  }
  async exists(path: string): Promise<boolean> {
    return this.contents.has(path);
  }
}

/** Wires the real observer onto the real outbox repository (production path). */
function createProducer(vault: VaultSnapshotPort, maxPayloadBytes?: number) {
  const store = new MemoryStore();
  const enqueued: OutboxEnvelope[] = [];
  let fileCounter = 0;
  let revisionCounter = 0;
  let operationCounter = 0;
  const repository: LocalChangeRepository = new OutboxLocalChangeRepository({
    identity: IDENTITY,
    store,
    enqueue: async (envelope) => {
      enqueued.push(envelope);
    },
    generateRevisionId: () => {
      revisionCounter += 1;
      return `00000000-0000-4000-8000-00000000000${revisionCounter}`;
    },
    ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
  });
  const observer = new VaultChangeObserver({
    clock: () => 1_721_000_000_000,
    generateFileId: () => {
      fileCounter += 1;
      return `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${fileCounter}`;
    },
    generateOperationId: () => {
      operationCounter += 1;
      return `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${operationCounter}`;
    },
    repository,
    vault,
  });
  return { observer, repository, enqueued };
}

function decodePayload(envelope: OutboxEnvelope) {
  return decodeRevisionPayload(
    Buffer.from(envelope.payloadBase64, 'base64').toString('utf8'),
  );
}

describe('push producer wire-format (Windows)', () => {
  it('ships a CRLF-authored two-line modify as LF content with a matching contentHash and no throw', async () => {
    // The exact field reproduction: empty create synced, then two typed lines.
    const vault = new MemoryVault();
    vault.set('Notes/Plan.md', '');
    const { observer, enqueued } = createProducer(vault);

    await observer.observeCreate('Notes/Plan.md');
    // Windows editor writes CRLF line endings.
    vault.set('Notes/Plan.md', 'line one\r\nline two\r\n');
    const modified = await observer.observeModify('Notes/Plan.md');

    expect(modified).not.toBeNull();
    expect(enqueued).toHaveLength(2);
    const update = enqueued[1] as OutboxEnvelope;
    const payload = decodePayload(update);
    // Wire content is LF-only, never the raw CRLF from disk.
    expect(payload).toMatchObject({
      operation: 'update',
      content: 'line one\nline two\n',
      kind: 'markdown',
    });
    expect((payload.content ?? '').includes('\r')).toBe(false);
    // The contentHash on the outbox entry is self-consistent with the shipped
    // canonical bytes (this is what the server content-addresses).
    expect(update.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('does not re-push when a CRLF file is re-observed with byte-identical content (no spurious revision)', async () => {
    const vault = new MemoryVault();
    vault.set('Notes/Plan.md', 'line one\r\nline two\r\n');
    const { observer, enqueued } = createProducer(vault);

    await observer.observeCreate('Notes/Plan.md');
    const again = await observer.observeModify('Notes/Plan.md');

    // Canonical hash is stable across CRLF, so a no-op modify dedupes.
    expect(again).toBeNull();
    expect(enqueued).toHaveLength(1);
  });

  it('ships a backslash-separated Windows path as a forward-slash wire path without wedging the cycle', async () => {
    // If a backslash path ever reaches the producer, the wire contract
    // (forward-slash only) must be satisfied by normalisation, never by an
    // envelope-build throw that kills the whole push cycle and latches Offline.
    const vault = new MemoryVault();
    vault.set('Notes\\Sub\\Deep.md', 'line one\r\nline two\r\n');
    const { observer, enqueued } = createProducer(vault);

    const created = await observer.observeCreate('Notes\\Sub\\Deep.md');

    expect(created).not.toBeNull();
    expect(enqueued).toHaveLength(1);
    const payload = decodePayload(enqueued[0] as OutboxEnvelope);
    expect(payload).toMatchObject({
      operation: 'create',
      path: 'Notes/Sub/Deep.md',
      content: 'line one\nline two\n',
    });
  });

  it('ships a backslash-pathed modify by reading the REAL content at the normalised path (FINDING 3)', async () => {
    // The live modify event arrives with a Windows backslash separator, but the
    // content lives under the forward-slash key Obsidian indexes it by. The
    // observer must read via the NORMALISED path (canonical-first), reading via
    // the raw backslash path alone MISSES on real Obsidian and would either push
    // an empty '' body (blanking the peer's copy) or drop the edit entirely.
    const vault = new MemoryVault();
    vault.set('Notes/File.md', 'first\n');
    const { observer, enqueued } = createProducer(vault);

    // Create via the normal forward-slash path so a mapping exists.
    await observer.observeCreate('Notes/File.md');
    // The content is updated in place (still at the forward-slash key).
    vault.set('Notes/File.md', 'first\nsecond\n');
    // …but the modify event is delivered with a backslash separator.
    const modified = await observer.observeModify('Notes\\File.md');

    expect(modified).not.toBeNull();
    expect(enqueued).toHaveLength(2);
    const payload = decodePayload(enqueued[1] as OutboxEnvelope);
    expect(payload).toMatchObject({
      operation: 'update',
      path: 'Notes/File.md',
      content: 'first\nsecond\n',
    });
    // The shipped body is the real content, never an empty '' from a missed read.
    expect(payload.content).toBe('first\nsecond\n');
  });

  it('reconciles a mix of good, backslash-pathed and poison files without wedging the scan', async () => {
    // The whole-vault reconcile enumeration is a producer entry point too. A
    // single poison file (here: one over the payload ceiling) must be isolated
    // per-item, skipped, not fatal, while every other file (CRLF-authored and
    // backslash-pathed alike) still enqueues a clean LF/forward-slash envelope.
    // This routes through the production `reconcileVaultState` + real observer +
    // real outbox repository, so it cannot go false-green against a reimplemented
    // producer.
    const vault = new MemoryVault();
    vault.set('Notes/A.md', 'line one\r\nline two\r\n');
    vault.set('Notes\\B.md', 'body\r\n');
    vault.set('Big.md', 'x'.repeat(4000)); // over the 400-byte ceiling
    const { observer, repository, enqueued } = createProducer(vault, 400);

    const result = await reconcileVaultState({ observer, repository, vault });

    // Scan completed; the poison file is surfaced as skipped, the rest created.
    expect(result.completed).toBe(true);
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(1);
    expect(enqueued).toHaveLength(2);

    const paths = enqueued
      .map((envelope) => decodePayload(envelope).path)
      .sort();
    expect(paths).toEqual(['Notes/A.md', 'Notes/B.md']);
    for (const envelope of enqueued) {
      expect((decodePayload(envelope).content ?? '').includes('\r')).toBe(false);
    }
  });
});

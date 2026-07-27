import { describe, expect, it } from 'vitest';

import type { DecodedRevisionPayload } from '@havemind/sync-core';

import {
  ActivityLog,
  remoteAppliedToActivityEntryOrNull,
} from './activity-log';
import {
  VaultApplyAdapter,
  type RemoteAppliedEvent,
  type VaultFilePort,
} from './vault-apply';
import {
  SyncRunner,
  type OpenBuffer,
  type PushItemResult,
  type PushRevision,
  type PullResult,
  type RemoteEvent,
  type SyncStatePort,
  type SyncTransport,
} from '../sync/sync-runner';

/**
 * Regression guard for the initial-bootstrap flood (UX): when a device first
 * materialises a PRE-EXISTING vault — a joining device pulling the whole vault,
 * or the owner re-pulling after a data.json wipe — the sync runner applies one
 * revision per file, each returning 'applied'. Recording each as an Activity
 * entry floods the feed with a full replay of the vault.
 *
 * The fix threads a `bootstrap` origin from the runner (every event at or below
 * the server head observed at connect) into the apply, and the Activity wiring
 * collapses bootstrap applies to silence while every LIVE peer edit afterwards
 * still records a normal entry. Files still land on disk unchanged — only the
 * Activity presentation differs.
 */

/** Minimal in-memory VaultFilePort: only what a create-apply exercises. */
class MemoryFiles implements VaultFilePort {
  readonly onDisk = new Map<string, string>();
  readonly owners = new Map<string, string>();
  private readonly baseHashes = new Map<string, string>();
  private readonly baseContents = new Map<string, string>();
  private readonly conflictPaths = new Map<string, string>();
  private readonly writtenConflicts = new Set<string>();

  openBufferStates(): readonly OpenBuffer[] {
    return [];
  }
  fileIdAtPath(path: string): string | null {
    return this.owners.get(path) ?? null;
  }
  async readByPath(path: string): Promise<string | null> {
    return this.onDisk.get(path) ?? null;
  }
  async readBinaryByPath(): Promise<Uint8Array | null> {
    return null;
  }
  async writeByPath(path: string, content: string): Promise<void> {
    this.onDisk.set(path, content);
  }
  async writeBinaryByPath(): Promise<void> {
    /* unused in these markdown tests */
  }
  async deleteByPath(path: string): Promise<void> {
    this.onDisk.delete(path);
  }
  async writeConflictArtifact(path: string, content: string): Promise<void> {
    this.onDisk.set(path, content);
    this.writtenConflicts.add(path);
  }
  async writeBinaryConflictArtifact(): Promise<void> {
    /* unused */
  }
  async recordPathOwner(fileId: string, path: string): Promise<void> {
    this.owners.set(path, fileId);
  }
  async forgetPath(path: string): Promise<void> {
    this.owners.delete(path);
  }
  baseHashFor(fileId: string): string | null {
    return this.baseHashes.get(fileId) ?? null;
  }
  async recordBaseHash(fileId: string, hash: string): Promise<void> {
    this.baseHashes.set(fileId, hash);
  }
  async forgetBaseHash(fileId: string): Promise<void> {
    this.baseHashes.delete(fileId);
  }
  baseContentFor(fileId: string): string | null {
    return this.baseContents.get(fileId) ?? null;
  }
  async recordBaseContent(fileId: string, content: string): Promise<void> {
    this.baseContents.set(fileId, content);
  }
  async forgetBaseContent(fileId: string): Promise<void> {
    this.baseContents.delete(fileId);
  }
  async conflictArtifactExists(path: string): Promise<boolean> {
    return this.writtenConflicts.has(path);
  }
  conflictArtifactPathFor(revisionId: string): string | null {
    return this.conflictPaths.get(revisionId) ?? null;
  }
  async recordConflictArtifactPath(revisionId: string, path: string): Promise<void> {
    this.conflictPaths.set(revisionId, path);
  }
}

/** In-memory SyncStatePort: an empty outbox and a movable cursor. */
class MemoryState implements SyncStatePort {
  cursor = 0;
  async loadCursor(): Promise<number> {
    return this.cursor;
  }
  async saveCursor(sequence: number): Promise<void> {
    this.cursor = sequence;
  }
  async listOutbox(): Promise<readonly PushRevision[]> {
    return [];
  }
  async recordPushReceipt(): Promise<void> {
    /* no local authorship in these pull-only tests */
  }
  async quarantineOutboxItem(): Promise<void> {
    /* unused */
  }
  async isLocallyAuthored(): Promise<boolean> {
    return false;
  }
}

/** A transport whose pull responses are scripted per cycle. */
class ScriptedTransport implements SyncTransport {
  private readonly pulls: PullResult[];
  constructor(pulls: PullResult[]) {
    this.pulls = [...pulls];
  }
  async push(): Promise<readonly PushItemResult[]> {
    return [];
  }
  async pull(after: number): Promise<PullResult> {
    return this.pulls.shift() ?? { cursor: after, events: [] };
  }
}

async function realSha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function makeHarness(pulls: PullResult[]) {
  const files = new MemoryFiles();
  const activity = new ActivityLog();
  const resolved = new Map<string, DecodedRevisionPayload>();

  const adapter = new VaultApplyAdapter({
    files,
    conflictFolder: 'Havemind Conflicts',
    resolveRevision: async (event: RemoteEvent) => {
      const payload = resolved.get(event.revision.revisionId);
      if (payload === undefined) throw new Error('no payload for revision');
      return payload;
    },
    hashContent: realSha256,
    // Production wiring (obsidian-adapters.ts): a bootstrap apply is collapsed to
    // silence, a live apply records a normal Activity entry.
    onRemoteApplied: (event: RemoteAppliedEvent) => {
      const entry = remoteAppliedToActivityEntryOrNull(event, Date.now());
      if (entry !== null) activity.record(entry);
    },
  });

  const runner = new SyncRunner({
    transport: new ScriptedTransport(pulls),
    state: new MemoryState(),
    vault: adapter,
    scheduler: () => undefined,
    random: () => 0,
  });

  return { files, activity, resolved, runner };
}

function createEvent(serverSequence: number, fileId: string): RemoteEvent {
  return {
    serverSequence,
    revision: {
      revisionId: `rev-${serverSequence}`,
      fileId,
      contentHash: `hash-${serverSequence}`,
    },
  };
}

function createPayload(path: string, text: string): DecodedRevisionPayload {
  return {
    operation: 'create',
    kind: 'markdown',
    path,
    content: text,
    previousPath: null,
  } as unknown as DecodedRevisionPayload;
}

describe('initial bootstrap is quiet in the Activity feed', () => {
  it('materialises N pre-existing files to disk but records ZERO Activity entries', async () => {
    const N = 5;
    const events = Array.from({ length: N }, (_, i) =>
      createEvent(i + 1, `file-${i}`),
    );
    const h = makeHarness([{ cursor: N, events }]);
    for (let i = 0; i < N; i += 1) {
      h.resolved.set(`rev-${i + 1}`, createPayload(`pre-${i}.md`, `content ${i}\n`));
    }

    const result = await h.runner.trigger();

    // Sync is intact: every bootstrap file lands on disk.
    expect(result.applied).toBe(N);
    expect(h.files.onDisk.size).toBe(N);
    for (let i = 0; i < N; i += 1) {
      expect(h.files.onDisk.get(`pre-${i}.md`)).toBe(`content ${i}\n`);
    }

    // The flood is gone: the whole bootstrap catch-up records NO Activity entry.
    expect(h.activity.snapshot()).toHaveLength(0);
  });

  it('records a live remote edit AFTER bootstrap as a normal Activity entry (positive control)', async () => {
    const N = 3;
    const bootstrap = Array.from({ length: N }, (_, i) =>
      createEvent(i + 1, `file-${i}`),
    );
    // Cycle 1: the bootstrap catch-up (head = N). Cycle 2: a live peer edit whose
    // serverSequence is beyond the connect-time head.
    const live = createEvent(N + 1, 'file-live');
    const h = makeHarness([
      { cursor: N, events: bootstrap },
      { cursor: N + 1, events: [live] },
    ]);
    for (let i = 0; i < N; i += 1) {
      h.resolved.set(`rev-${i + 1}`, createPayload(`pre-${i}.md`, `content ${i}\n`));
    }
    h.resolved.set(`rev-${N + 1}`, createPayload('live.md', 'live edit\n'));

    await h.runner.trigger();
    expect(h.activity.snapshot()).toHaveLength(0);

    await h.runner.trigger();

    const entries = h.activity.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('live.md');
    expect(entries[0]?.author.kind).toBe('remote');
    // The live file materialised alongside the bootstrap files.
    expect(h.files.onDisk.get('live.md')).toBe('live edit\n');
  });
});

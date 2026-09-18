/**
 * An empty parent list must behave exactly like an absent one.
 *
 * `RemoteRevision.parentRevisionIds` is documented as "absent (or empty) when
 * the transport cannot surface it" (sync-runner.ts), and every caller reads that
 * as one best-effort case. `isCausalFastForward` checks only `=== undefined`,
 * so `[]` falls through to real membership testing and can never match a local
 * head: a root create decodes to `[]` (the server relays
 * `parentRevisionIds: [...header.parentRevisionIds]` verbatim, and the client's
 * decoder keeps it because `Array.isArray([])` holds), so the two supposedly
 * equivalent shapes take opposite branches.
 *
 * Today the gap is mostly inert because the causal check runs only when a file
 * already exists on disk. It is pinned here because the divergence between the
 * documented contract and the code is exactly the kind of latent mismatch that
 * bites the next caller who trusts the comment.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DecodedRevisionPayload } from '@havemind/sync-core';

import type { RemoteEvent } from '../sync/sync-runner';
import { VaultApplyAdapter, type VaultFilePort } from './vault-apply';

const FILE_ID = '22222222-2222-4222-8222-222222222222';
const PATH = 'Notes/note.md';
const ON_DISK = 'SHARED\n';
const INCOMING = 'PEER EDIT\n';

function hashText(content: string): Promise<string> {
  return Promise.resolve(
    createHash('sha256').update(content, 'utf8').digest('hex'),
  );
}

/** A file whose on-disk content equals its recorded base: no local divergence. */
function makePort(): VaultFilePort & { written: string[]; conflicts: string[] } {
  const port = {
    written: [] as string[],
    conflicts: [] as string[],
    openBufferStates: () => [],
    fileIdAtPath: () => FILE_ID,
    readByPath: async (path: string) => (path === PATH ? ON_DISK : null),
    readBinaryByPath: async () => null,
    writeByPath: async (_path: string, content: string) => {
      port.written.push(content);
    },
    writeBinaryByPath: async () => undefined,
    deleteByPath: async () => undefined,
    writeConflictArtifact: async (_path: string, content: string) => {
      port.conflicts.push(content);
    },
    writeBinaryConflictArtifact: async () => undefined,
    recordPathOwner: async () => undefined,
    forgetPath: async () => undefined,
    baseHashFor: () =>
      createHash('sha256').update(ON_DISK, 'utf8').digest('hex'),
    recordBaseHash: async () => undefined,
    forgetBaseHash: async () => undefined,
    baseContentFor: () => ON_DISK,
    recordBaseContent: async () => undefined,
    forgetBaseContent: async () => undefined,
    conflictArtifactExists: async () => false,
    conflictArtifactPathFor: () => null,
    recordConflictArtifactPath: async () => undefined,
  };
  return port as unknown as VaultFilePort & {
    written: string[];
    conflicts: string[];
  };
}

function makeAdapter(port: VaultFilePort): VaultApplyAdapter {
  return new VaultApplyAdapter({
    files: port,
    conflictFolder: 'Havemind Conflicts',
    resolveRevision: async (): Promise<DecodedRevisionPayload> => ({
      kind: 'markdown',
      operation: 'update',
      path: PATH,
      previousPath: null,
      content: INCOMING,
    }),
    hashContent: hashText,
    // No `localHeadFor`: the shape a device has before push identity lands.
    producerSync: {
      onRemoteWrite: async () => undefined,
      onRemoteDelete: async () => undefined,
    },
  });
}

function event(parents?: readonly string[]): RemoteEvent {
  return {
    serverSequence: 9,
    revision: {
      revisionId: '33333333-3333-4333-8333-333333333333',
      fileId: FILE_ID,
      contentHash: 'irrelevant',
      ...(parents === undefined ? {} : { parentRevisionIds: parents }),
    },
  };
}

describe('empty vs absent parentRevisionIds', () => {
  it('treats an empty parent list the same as an absent one', async () => {
    const absentPort = makePort();
    const absentOutcome = await makeAdapter(absentPort).applyRemote(event());

    const emptyPort = makePort();
    const emptyOutcome = await makeAdapter(emptyPort).applyRemote(event([]));

    expect(emptyOutcome).toBe(absentOutcome);
    expect(emptyPort.conflicts).toEqual(absentPort.conflicts);
  });

  it('applies a non-matching lineage when this side never diverged', async () => {
    // Not a contradiction of the guard: on-disk equals the base, so the merge
    // ancestor equals the local side and the three-way merge resolves to the
    // peer's text cleanly. A conflict copy here would be a false positive.
    // Pinned so a future tightening of the causal check does not start
    // conflicting files this device never touched.
    const port = makePort();
    const outcome = await makeAdapter(port).applyRemote(
      event(['44444444-4444-4444-8444-444444444444']),
    );
    expect(outcome).toBe('applied');
    expect(port.conflicts).toEqual([]);
  });
});

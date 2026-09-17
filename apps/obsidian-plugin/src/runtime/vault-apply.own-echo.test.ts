/**
 * `acknowledgeOwnEcho` must record the base in the unit the base is kept in.
 *
 * `baseHashes` is a PLAINTEXT-hash namespace: every other writer stores
 * `hashContent(text)` (the canonicalised note text). A pull receipt's
 * `contentHash` is something else entirely, the hash of the revision ENVELOPE
 * bytes (`buildRevisionEnvelope` → `sha256Hex(bytes)` over the payload JSON,
 * which wraps the text plus schemaVersion/operation/path/plaintextHash).
 *
 * Writing the envelope hash into the plaintext-hash slot poisons the base for
 * every file this device pushed:
 *  - the on-disk overwrite guard reads `onDiskHash !== base` as ALWAYS diverged,
 *  - `tryMergeApply` bails on `hashContent(ancestor) !== base`, so the
 *    three-way merge becomes structurally unreachable,
 *  - the open-buffer guard sees every buffer for that file as divergent.
 * The device then conflicts every incoming peer revision, including a plain
 * fast-forward. That is the "constant conflicts, files stop flowing" report.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DecodedRevisionPayload } from '@havemind/sync-core';

import type { RemoteEvent } from '../sync/sync-runner';
import { VaultApplyAdapter, type VaultFilePort } from './vault-apply';

const FILE_ID = '22222222-2222-4222-8222-222222222222';
const REVISION_ID = '33333333-3333-4333-8333-333333333333';
const PATH = 'Notes/note.md';
const TEXT = 'V2-local\n';

function hashText(content: string): Promise<string> {
  return Promise.resolve(
    createHash('sha256').update(content, 'utf8').digest('hex'),
  );
}

/** The envelope-bytes hash a real pull receipt carries: never the text hash. */
function envelopeHash(content: string): string {
  const payload = JSON.stringify({
    schemaVersion: 1,
    operation: 'update',
    path: PATH.toLowerCase(),
    content,
    plaintextHash: createHash('sha256').update(content, 'utf8').digest('hex'),
  });
  return createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
}

function makePort(): VaultFilePort & {
  recordedBaseHash: string | null;
  recordedBaseContent: string | null;
} {
  const port = {
    recordedBaseHash: null as string | null,
    recordedBaseContent: null as string | null,
    openBufferStates: () => [],
    fileIdAtPath: () => FILE_ID,
    readByPath: async (path: string) => (path === PATH ? TEXT : null),
    readBinaryByPath: async () => null,
    writeByPath: async () => undefined,
    writeBinaryByPath: async () => undefined,
    deleteByPath: async () => undefined,
    writeConflictArtifact: async () => undefined,
    writeBinaryConflictArtifact: async () => undefined,
    recordPathOwner: async () => undefined,
    forgetPath: async () => undefined,
    baseHashFor: () => port.recordedBaseHash,
    recordBaseHash: async (_fileId: string, hash: string) => {
      port.recordedBaseHash = hash;
    },
    forgetBaseHash: async () => undefined,
    baseContentFor: () => port.recordedBaseContent,
    recordBaseContent: async (_fileId: string, content: string) => {
      port.recordedBaseContent = content;
    },
    forgetBaseContent: async () => undefined,
    conflictArtifactExists: async () => false,
    conflictArtifactPathFor: () => null,
    recordConflictArtifactPath: async () => undefined,
  };
  return port as unknown as VaultFilePort & {
    recordedBaseHash: string | null;
    recordedBaseContent: string | null;
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
      content: TEXT,
    }),
    hashContent: hashText,
  });
}

function ownEcho(): RemoteEvent {
  return {
    serverSequence: 7,
    revision: {
      revisionId: REVISION_ID,
      fileId: FILE_ID,
      // What the transport actually surfaces: the envelope-bytes hash.
      contentHash: envelopeHash(TEXT),
    },
  };
}

describe('acknowledgeOwnEcho base units', () => {
  it('records the plaintext hash of the on-disk text, not the envelope hash', async () => {
    const port = makePort();
    await makeAdapter(port).acknowledgeOwnEcho(ownEcho());

    const expected = await hashText(TEXT);
    expect(port.recordedBaseHash).toBe(expected);
    expect(port.recordedBaseHash).not.toBe(envelopeHash(TEXT));
  });

  it('records a base whose hash matches its own recorded ancestor content', async () => {
    // `tryMergeApply` refuses to merge unless hashContent(ancestor) === base.
    // If those two disagree the three-way merge is unreachable and every
    // divergence degrades to a conflict copy.
    const port = makePort();
    await makeAdapter(port).acknowledgeOwnEcho(ownEcho());

    expect(port.recordedBaseContent).not.toBeNull();
    expect(await hashText(port.recordedBaseContent as string)).toBe(
      port.recordedBaseHash,
    );
  });
});

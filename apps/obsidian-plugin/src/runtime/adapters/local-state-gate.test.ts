import { describe, expect, it } from 'vitest';

import { gateLocalSyncState } from './local-state-gate';

const healthySync = {
  version: 1,
  cursor: 42,
  outbox: [],
  locallyAuthored: [],
  deferred: [],
};

const healthyProducer = {
  mappings: [
    {
      collisionKey: 'note.md',
      content: 'hello\n',
      contentHash: 'hash-1',
      fileId: 'file-1',
      path: 'Note.md',
    },
  ],
  heads: { 'file-1': 'rev-1' },
};

describe('local sync-state startup gate (AUD-12)', () => {
  it('allows a genuine first connection with neither state container yet', () => {
    expect(gateLocalSyncState({ ownerConnection: { vaultId: 'vault-1' } })).toEqual({
      kind: 'allow',
    });
  });

  it('allows a consistent established state', () => {
    expect(
      gateLocalSyncState({ syncState: healthySync, pushProducer: healthyProducer }),
    ).toEqual({ kind: 'allow' });
  });

  it.each([
    {
      label: 'sync state disappeared while producer identity survived',
      data: { pushProducer: healthyProducer },
      reason: 'missing-sync-state',
    },
    {
      label: 'producer identity disappeared after the cursor advanced',
      data: { syncState: healthySync },
      reason: 'missing-producer-state',
    },
    {
      label: 'sync state is structurally corrupt',
      data: { syncState: { ...healthySync, cursor: 'bad' }, pushProducer: healthyProducer },
      reason: 'corrupt-sync-state',
    },
    {
      label: 'producer state is structurally corrupt',
      data: { syncState: healthySync, pushProducer: { mappings: [], heads: 'bad' } },
      reason: 'corrupt-producer-state',
    },
  ])('blocks before networking when $label', ({ data, reason }) => {
    expect(gateLocalSyncState(data)).toEqual({
      kind: 'recovery-required',
      reason,
    });
  });

  it('blocks a cursor reset to zero when producer heads prove prior sync', () => {
    expect(
      gateLocalSyncState({
        syncState: { ...healthySync, cursor: 0 },
        pushProducer: healthyProducer,
      }),
    ).toEqual({ kind: 'recovery-required', reason: 'cursor-reset' });
  });

  it('allows cursor zero when both containers are genuinely empty', () => {
    expect(
      gateLocalSyncState({
        syncState: { ...healthySync, cursor: 0 },
        pushProducer: { mappings: [], heads: {} },
      }),
    ).toEqual({ kind: 'allow' });
  });
});

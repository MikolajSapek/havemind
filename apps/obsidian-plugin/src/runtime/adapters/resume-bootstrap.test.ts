/**
 * Resuming an interrupted bootstrap must not push the half-materialised vault
 * back at the owner.
 *
 * When the gate reports `resume-bootstrap`, the vault already holds heads that
 * the unfinished join wrote. Connect-time reconcile enumerates exactly those
 * files; any whose producer mapping never landed look like brand-new local
 * notes, so it pushes them under fresh fileIds. On the owner that arrives as a
 * deleted note coming back, plus a conflict copy per path.
 *
 * So the resume path finishes the bootstrap (which is convergent, every head
 * that already matches disk is a no-op) and skips that one reconcile.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type * as ReconciliationModuleType from '../../sync/reconciliation';

import { startPushProducer } from './push-producer';

type ReconciliationModule = typeof ReconciliationModuleType;

// The producer arms a config poll through `window.setInterval`; this suite runs
// in the node environment, so supply just that surface rather than a DOM.
beforeAll(() => {
  (globalThis as { window?: unknown }).window ??= {
    setInterval: (handler: () => void, ms: number) =>
      globalThis.setInterval(handler, ms),
    clearInterval: (id: number) => globalThis.clearInterval(id),
  };
});

vi.mock('obsidian', () => ({
  Notice: class {
    constructor() {
      /* silent in tests */
    }
  },
}));

const reconcileSpy = vi.hoisted(() => vi.fn());

vi.mock('../../sync/reconciliation', async (importOriginal) => {
  const actual = await importOriginal<ReconciliationModule>();
  return {
    ...actual,
    reconcileVaultState: (...args: unknown[]) => {
      reconcileSpy(...args);
      return Promise.resolve({
        attachmentsExcluded: 0,
        binaryExcluded: 0,
        completed: true,
        created: 0,
        deleted: 0,
        ignored: 0,
        renamed: 0,
        skipped: 0,
        skippedPaths: [],
        unchanged: 0,
        updated: 0,
      });
    },
  };
});

const IDENTITY = {
  vaultId: '11111111-1111-4111-8111-111111111111',
  memberId: '22222222-2222-4222-8222-222222222222',
  deviceId: '33333333-3333-4333-8333-333333333333',
};

function fakePlugin() {
  let data: Record<string, unknown> = {};
  return {
    app: {
      vault: {
        getFiles: () => [],
        getAbstractFileByPath: () => null,
        read: async () => '',
        readBinary: async () => new ArrayBuffer(0),
        adapter: {
          exists: async () => false,
          read: async () => '',
          readBinary: async () => new ArrayBuffer(0),
          list: async () => ({ files: [], folders: [] }),
        },
        on: () => ({}),
        offref: () => undefined,
      },
      workspace: { on: () => ({}), offref: () => undefined },
    },
    registerEvent: () => undefined,
    registerInterval: () => undefined,
    async loadData() {
      return data;
    },
    async saveData(next: Record<string, unknown>) {
      data = next;
    },
  } as never;
}

function fakeState() {
  return {
    async enqueue() {
      /* unused */
    },
    async runBatched<T>(body: () => Promise<T>) {
      return body();
    },
    fileStateSnapshot() {
      return { pathOwners: {}, baseHashes: {}, baseContents: {} };
    },
  } as never;
}

describe('resume-bootstrap producer start', () => {
  it('skips the connect-time reconcile when asked to', async () => {
    reconcileSpy.mockClear();
    const handle = startPushProducer(
      fakePlugin(),
      fakeState(),
      IDENTITY,
      () => undefined,
      { current: null },
      undefined,
      undefined,
      { skipInitialReconcile: true },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcileSpy).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('still reconciles on an ordinary connect', async () => {
    reconcileSpy.mockClear();
    const handle = startPushProducer(
      fakePlugin(),
      fakeState(),
      IDENTITY,
      () => undefined,
      { current: null },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    handle.dispose();
  });
});

/**
 * Fixtures shared by the plugin tests: the manifest a headless plugin loads
 * with, a macrotask flush, a real SHA-256, and in-memory producer and sync
 * state stores.
 */

import type { PluginManifest } from './obsidian.mock';
import type { PersistedSyncState } from '../runtime/sync-state';
import type { ProducerState } from '../sync/outbox-repository';

export const manifest: PluginManifest = {
  author: 'Mikolaj Pawel Sapek',
  description: 'Synchronize shared Markdown vaults with durable history.',
  id: 'havemind-sync',
  isDesktopOnly: true,
  minAppVersion: '1.11.4',
  name: 'Havemind',
  version: '0.0.1',
};

/** Resolves after pending timers and microtasks, so fire-and-forget work settles. */
export function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export async function realSha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export class MemoryProducerStore {
  state: ProducerState = { mappings: [], heads: {} };
  async load(): Promise<ProducerState> {
    return this.state;
  }
  async save(state: ProducerState): Promise<void> {
    this.state = state;
  }
}

/** Sync-state persistence in memory, keeping the previous save as the backup. */
export function makeMemoryPersist(): {
  load(): Promise<unknown>;
  loadBackup(): Promise<unknown>;
  save(state: PersistedSyncState): Promise<void>;
  preserveCorrupt(raw: unknown, timestamp: number): Promise<void>;
} {
  let stored: PersistedSyncState | null = null;
  let backup: PersistedSyncState | null = null;
  return {
    async load() {
      return stored;
    },
    async loadBackup() {
      return backup;
    },
    async save(state) {
      backup = stored;
      stored = state;
    },
    async preserveCorrupt() {
      /* no-op: these harnesses never seed a corrupt blob */
    },
  };
}

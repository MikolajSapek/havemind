import { describe, expect, it } from 'vitest';

import {
  healStaleBasesAfterLocalPush,
  type LocalBaseHealStore,
} from './local-base-lifecycle';

class FakeHealStore implements LocalBaseHealStore {
  readonly bases = new Map<string, string>();
  readonly contents = new Map<string, string>();
  readonly authored = new Set<string>();
  readonly owners = new Map<string, string>();

  baseHashFor(fileId: string): string | null {
    return this.bases.get(fileId) ?? null;
  }
  async recordPathOwner(fileId: string, path: string): Promise<void> {
    this.owners.set(path, fileId);
  }
  async recordBaseHash(fileId: string, hash: string): Promise<void> {
    this.bases.set(fileId, hash);
  }
  async recordBaseContent(fileId: string, content: string): Promise<void> {
    this.contents.set(fileId, content);
  }
  async forgetPath(path: string): Promise<void> {
    this.owners.delete(path);
  }
  async forgetBaseHash(fileId: string): Promise<void> {
    this.bases.delete(fileId);
  }
  async forgetBaseContent(fileId: string): Promise<void> {
    this.contents.delete(fileId);
  }
  async isLocallyAuthored(revisionId: string): Promise<boolean> {
    return this.authored.has(revisionId);
  }
}

describe('healStaleBasesAfterLocalPush', () => {
  it('advances base when head was pushed and mapping content is ahead of base', async () => {
    const store = new FakeHealStore();
    store.bases.set('file-1', 'old-base');
    store.authored.add('rev-pushed');

    const healed = await healStaleBasesAfterLocalPush(
      store,
      [
        {
          fileId: 'file-1',
          contentHash: 'new-content',
          content: 'hello',
        },
      ],
      () => 'rev-pushed',
    );

    expect(healed).toBe(1);
    expect(store.bases.get('file-1')).toBe('new-content');
    expect(store.contents.get('file-1')).toBe('hello');
  });

  it('does not advance base when head was never accepted by the server', async () => {
    const store = new FakeHealStore();
    store.bases.set('file-1', 'old-base');

    const healed = await healStaleBasesAfterLocalPush(
      store,
      [
        {
          fileId: 'file-1',
          contentHash: 'new-content',
          content: 'hello',
        },
      ],
      () => 'rev-unsent',
    );

    expect(healed).toBe(0);
    expect(store.bases.get('file-1')).toBe('old-base');
  });

  it('does not advance base when disk no longer matches the mapping hash', async () => {
    const store = new FakeHealStore();
    store.bases.set('file-1', 'old-base');
    store.authored.add('rev-pushed');

    const healed = await healStaleBasesAfterLocalPush(
      store,
      [
        {
          fileId: 'file-1',
          contentHash: 'new-content',
          content: 'hello',
        },
      ],
      () => 'rev-pushed',
      async () => 'disk-diverged',
    );

    expect(healed).toBe(0);
    expect(store.bases.get('file-1')).toBe('old-base');
  });

  it('advances base when disk hash matches the mapping', async () => {
    const store = new FakeHealStore();
    store.bases.set('file-1', 'old-base');
    store.authored.add('rev-pushed');

    const healed = await healStaleBasesAfterLocalPush(
      store,
      [
        {
          fileId: 'file-1',
          contentHash: 'new-content',
          content: 'hello',
        },
      ],
      () => 'rev-pushed',
      async () => 'new-content',
    );

    expect(healed).toBe(1);
    expect(store.bases.get('file-1')).toBe('new-content');
  });
});

import { describe, expect, it } from 'vitest';

import type { LocalFileMapping } from '../obsidian/vault-adapter';
import {
  createRemoteApplyProducerSync,
  type AdoptableProducer,
} from './remote-apply-coordinator';

class FakeProducer implements AdoptableProducer {
  adopted: Array<{ mapping: LocalFileMapping; head: string }> = [];
  forgotten: Array<{ collisionKey: string; fileId: string }> = [];
  heads = new Map<string, string>();

  async adoptRemoteMapping(
    mapping: LocalFileMapping,
    headRevisionId: string,
  ): Promise<void> {
    this.adopted.push({ mapping, head: headRevisionId });
  }

  async forgetRemoteMapping(collisionKey: string, fileId: string): Promise<void> {
    this.forgotten.push({ collisionKey, fileId });
  }

  async headFor(fileId: string): Promise<string | null> {
    return this.heads.get(fileId) ?? null;
  }
}

describe('createRemoteApplyProducerSync', () => {
  it('adopts an eligible remote write into the producer mapping', async () => {
    const producer = new FakeProducer();
    const sync = createRemoteApplyProducerSync(() => producer);

    await sync.onRemoteWrite({
      fileId: 'remote-file',
      path: 'Notes/Shared.md',
      content: 'SHARED\n',
      contentHash: 'hash-s',
      revisionId: 'rev-1',
    });

    expect(producer.adopted).toEqual([
      {
        mapping: {
          collisionKey: 'notes/shared.md',
          content: 'SHARED\n',
          contentHash: 'hash-s',
          fileId: 'remote-file',
          path: 'Notes/Shared.md',
        },
        head: 'rev-1',
      },
    ]);
  });

  it('forgets an eligible remote delete', async () => {
    const producer = new FakeProducer();
    const sync = createRemoteApplyProducerSync(() => producer);

    await sync.onRemoteDelete({ fileId: 'remote-file', path: 'Notes/Shared.md' });

    expect(producer.forgotten).toEqual([
      { collisionKey: 'notes/shared.md', fileId: 'remote-file' },
    ]);
  });

  it('is inert before the producer exists (null binding)', async () => {
    const sync = createRemoteApplyProducerSync(() => null);
    await expect(
      sync.onRemoteWrite({
        fileId: 'f',
        path: 'Notes/a.md',
        content: 'A\n',
        contentHash: 'h',
        revisionId: 'r',
      }),
    ).resolves.toBeUndefined();
    await expect(
      sync.onRemoteDelete({ fileId: 'f', path: 'Notes/a.md' }),
    ).resolves.toBeUndefined();
  });

  it('skips an ineligible path (reserved folder / non-markdown)', async () => {
    const producer = new FakeProducer();
    const sync = createRemoteApplyProducerSync(() => producer);

    await sync.onRemoteWrite({
      fileId: 'f',
      path: 'Havemind Conflicts/x.md',
      content: 'X\n',
      contentHash: 'h',
      revisionId: 'r',
    });

    expect(producer.adopted).toEqual([]);
  });
});

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BlobIntegrityError,
  BlobStore,
  type BlobWriteResult,
} from './blob-store.js';
import {
  InjectedFaultError,
  failOnceAt,
  type BlobStoreFaultPoint,
} from './faults.js';

const temporaryDirectories: string[] = [];

async function makeStore(
  faultPoint?: BlobStoreFaultPoint,
): Promise<{ directory: string; store: BlobStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'havemind-blobs-'));
  temporaryDirectories.push(directory);
  return {
    directory,
    store: new BlobStore(
      join(directory, 'blobs'),
      faultPoint === undefined ? undefined : failOnceAt(faultPoint),
    ),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('BlobStore', () => {
  it('hashes server-side and durably stores the exact bytes', async () => {
    const { store } = await makeStore();
    const bytes = new TextEncoder().encode('opaque\0payload');

    const result = await store.put(bytes);

    expect(result).toMatchObject({
      byteLength: bytes.byteLength,
      created: true,
      hash: '4fd3f78a8185f09acfef5ff35f05fd2f013f8425bcdf986862b76aea711886b0',
    });
    expect(await readFile(store.pathForHash(result.hash))).toEqual(
      Buffer.from(bytes),
    );
    expect((await stat(store.pathForHash(result.hash))).mode & 0o777).toBe(0o600);
  });

  it('verifies an existing blob and never overwrites corrupt bytes', async () => {
    const { store } = await makeStore();
    const bytes = new TextEncoder().encode('immutable');
    const first = await store.put(bytes);
    const second = await store.put(bytes);

    expect(second).toEqual<BlobWriteResult>({ ...first, created: false });

    await writeFile(store.pathForHash(first.hash), 'corrupt');
    await expect(store.put(bytes)).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(await readFile(store.pathForHash(first.hash), 'utf8')).toBe('corrupt');
  });

  it('serializes concurrent writes for the same content', async () => {
    const { store } = await makeStore();
    const bytes = new TextEncoder().encode('same bytes');

    const results = await Promise.all(
      Array.from({ length: 12 }, async () => store.put(bytes)),
    );

    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(new Set(results.map(({ hash }) => hash))).toHaveLength(1);
    const first = results[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error('Expected at least one blob result.');
    }
    expect(await store.read(first.hash)).toEqual(Buffer.from(bytes));
  });

  it('rejects invalid hash paths and non-file blob entries', async () => {
    const { directory, store } = await makeStore();
    expect(() => store.pathForHash('invalid' as never)).toThrow();

    const stored = await store.put(new TextEncoder().encode('directory trap'));
    const path = store.pathForHash(stored.hash);
    await rm(path);
    await mkdir(path);

    await expect(store.read(stored.hash)).rejects.toBeInstanceOf(
      BlobIntegrityError,
    );

    await rm(path, { recursive: true });
    const symlinkTarget = join(directory, 'symlink-target');
    await writeFile(symlinkTarget, 'directory trap');
    await symlink(symlinkTarget, path);
    await expect(store.read(stored.hash)).rejects.toBeInstanceOf(
      BlobIntegrityError,
    );
  });

  it.each([
    'after-temp-write',
    'after-file-fsync',
    'after-rename',
    'after-directory-fsync',
  ] satisfies BlobStoreFaultPoint[])(
    'recovers safely after an injected crash at %s',
    async (faultPoint) => {
      const { store } = await makeStore(faultPoint);
      const bytes = new TextEncoder().encode(`recovery-${faultPoint}`);

      await expect(store.put(bytes)).rejects.toBeInstanceOf(InjectedFaultError);

      const recovered = await store.put(bytes);
      expect(await store.read(recovered.hash)).toEqual(Buffer.from(bytes));
      expect(recovered.byteLength).toBe(bytes.byteLength);
    },
  );
});

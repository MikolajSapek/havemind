import {
  constants,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  blobHashSchema,
  hashBlob,
  type BlobHash,
} from '@havemind/protocol';

import type {
  BlobStoreFaultInjector,
  BlobStoreFaultPoint,
} from './faults.js';

const NO_FAULTS: BlobStoreFaultInjector = {
  hit(): void {},
};

export interface BlobWriteResult {
  readonly hash: BlobHash;
  readonly byteLength: number;
  readonly created: boolean;
}

export class BlobIntegrityError extends Error {
  public readonly hash: BlobHash;

  public constructor(hash: BlobHash, reason: string) {
    super(`Blob ${hash} failed integrity verification: ${reason}`);
    this.name = 'BlobIntegrityError';
    this.hash = hash;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class BlobStore {
  readonly #rootDirectory: string;
  readonly #faults: BlobStoreFaultInjector;
  readonly #writes = new Map<string, Promise<BlobWriteResult>>();

  public constructor(
    rootDirectory: string,
    faults: BlobStoreFaultInjector = NO_FAULTS,
  ) {
    this.#rootDirectory = rootDirectory;
    this.#faults = faults;
  }

  public pathForHash(hash: BlobHash): string {
    const validatedHash = blobHashSchema.parse(hash);
    return join(
      this.#rootDirectory,
      validatedHash.slice(0, 2),
      validatedHash,
    );
  }

  /**
   * Reads a content-addressed blob WITHOUT recomputing its hash. Blobs are
   * verified against their hash at write time (see `#verifyExisting`, invoked
   * from `#putSerialized`, and `readVerified` on the commit path), so a GET on
   * the read hot path only needs an O(1) structural check — reject symlinks
   * (O_NOFOLLOW) and non-regular files — never a full-file SHA-256 that would
   * read up to 36 MiB per request.
   */
  public async read(hash: BlobHash): Promise<Buffer> {
    const path = this.pathForHash(hash);
    return this.#readExisting(path, hash);
  }

  /**
   * Like `read`, but re-hashes the bytes and rejects any mismatch. Reserved
   * for the write/commit path (`RevisionRepository`), which double-checks a
   * freshly-`put` blob before durably committing the revision that references
   * it. Never call this from the read hot path — see `read`.
   */
  public async readVerified(hash: BlobHash): Promise<Buffer> {
    const path = this.pathForHash(hash);
    return this.#verifyExisting(path, hash);
  }

  /**
   * Best-effort removal of a blob that turned out to be orphaned (for example
   * a rejected revision's blob no committed revision ends up referencing).
   * The store is content-addressed and idempotent, so this is safe to call
   * even if another writer is concurrently recreating the same hash: `put`
   * always re-materializes the bytes from scratch when the path is absent.
   */
  public async remove(hash: BlobHash): Promise<void> {
    const path = this.pathForHash(hash);
    await unlinkIfPresent(path);
  }

  /**
   * Enumerates every blob hash currently materialised on disk by walking the
   * two-level shard directory layout. Used only by the startup orphan sweep
   * (see `blob-gc.ts`), which is the sole place blob deletion by liveness is
   * decided — never from the request hot path.
   */
  public async listHashes(): Promise<readonly BlobHash[]> {
    let shardNames: string[];
    try {
      shardNames = await readdir(this.#rootDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const hashes: BlobHash[] = [];
    for (const shardName of shardNames) {
      const shardPath = join(this.#rootDirectory, shardName);
      let entries: string[];
      try {
        entries = await readdir(shardPath);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      for (const entry of entries) {
        const parsed = blobHashSchema.safeParse(entry);
        if (parsed.success) {
          hashes.push(parsed.data);
        }
      }
    }
    return hashes;
  }

  public async put(input: Uint8Array): Promise<BlobWriteResult> {
    const bytes = Buffer.from(input);
    const hash = await hashBlob(bytes);
    const predecessor = this.#writes.get(hash);
    const operation = (predecessor?.catch(() => undefined) ?? Promise.resolve())
      .then(async () => this.#putSerialized(hash, bytes));

    this.#writes.set(hash, operation);
    try {
      return await operation;
    } finally {
      if (this.#writes.get(hash) === operation) {
        this.#writes.delete(hash);
      }
    }
  }

  async #putSerialized(
    hash: BlobHash,
    bytes: Buffer,
  ): Promise<BlobWriteResult> {
    const finalPath = this.pathForHash(hash);
    const parentDirectory = dirname(finalPath);
    await mkdir(parentDirectory, { mode: 0o700, recursive: true });

    if (await pathExists(finalPath)) {
      await this.#verifyExisting(finalPath, hash);
      // A previous process may have crashed after rename but before syncing the
      // directory entry. Syncing on replay completes that publication safely.
      await syncDirectory(parentDirectory);
      await this.#hit('after-directory-fsync');
      return { hash, byteLength: bytes.byteLength, created: false };
    }

    const temporaryPath = join(
      parentDirectory,
      `.${hash}.${process.pid}.${randomUUID()}.tmp`,
    );
    let renamed = false;

    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await this.#hit('after-temp-write');
        await handle.sync();
        await this.#hit('after-file-fsync');
      } finally {
        await handle.close();
      }

      // All writers for a hash are serialized in this process. Deployments use
      // the database's single-writer lock, so rename cannot replace different
      // valid bytes: the destination name is derived from those exact bytes.
      await rename(temporaryPath, finalPath);
      renamed = true;
      await this.#hit('after-rename');
      await syncDirectory(parentDirectory);
      await this.#hit('after-directory-fsync');

      return { hash, byteLength: bytes.byteLength, created: true };
    } finally {
      if (!renamed) {
        await unlinkIfPresent(temporaryPath);
      }
    }
  }

  /**
   * Opens and reads the on-disk bytes for a blob, enforcing only the O(1)
   * structural invariants (reject symlinks via O_NOFOLLOW, reject non-regular
   * files). Does NOT recompute the hash — callers that need integrity
   * verification wrap this in `#verifyExisting`.
   */
  async #readExisting(
    path: string,
    expectedHash: BlobHash,
  ): Promise<Buffer> {
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ELOOP') {
        throw new BlobIntegrityError(expectedHash, 'symbolic links are rejected');
      }
      throw error;
    }

    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) {
        throw new BlobIntegrityError(expectedHash, 'path is not a regular file');
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async #verifyExisting(
    path: string,
    expectedHash: BlobHash,
  ): Promise<Buffer> {
    const bytes = await this.#readExisting(path, expectedHash);
    const actualHash = await hashBlob(bytes);
    if (actualHash !== expectedHash) {
      throw new BlobIntegrityError(
        expectedHash,
        `stored bytes hash to ${actualHash}`,
      );
    }
    return bytes;
  }

  async #hit(point: BlobStoreFaultPoint): Promise<void> {
    await this.#faults.hit(point);
  }
}

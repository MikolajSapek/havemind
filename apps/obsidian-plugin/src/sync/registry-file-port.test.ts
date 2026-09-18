/**
 * The apply side's six state-writing methods, backed by one registry.
 *
 * `VaultFilePort` exposes `recordPathOwner`, `forgetPath`, `recordBaseHash`,
 * `forgetBaseHash`, `recordBaseContent` and `forgetBaseContent` as six
 * independent writes over three separate maps. `vault-apply.ts` calls them 42
 * times, and a branch that updates one but not another leaves the state
 * half-written: an ancestor that no longer hashes to its base makes the
 * three-way merge unsatisfiable, and a path owner without a base makes every
 * incoming revision look divergent.
 *
 * `createRegistryStatePort` keeps the same six-method shape, so `vault-apply.ts`
 * does not have to change in one big rewrite, but routes every write into a
 * single `FileRegistry` record. Half-written states stop being representable:
 * the ancestor and its hash move together because they are one assignment.
 */

import { describe, expect, it } from 'vitest';

import { FileRegistry } from './file-registry';
import { createRegistryStatePort } from './registry-file-port';

const FILE_A = 'file-a';
const PATH_A = 'Notes/a.md';

function makePort() {
  const registry = new FileRegistry();
  return { registry, port: createRegistryStatePort(registry) };
}

describe('registry-backed state port', () => {
  it('reads back what it recorded', async () => {
    const { port } = makePort();
    await port.recordPathOwner(FILE_A, PATH_A);
    await port.recordBaseHash(FILE_A, 'h1');
    await port.recordBaseContent(FILE_A, 'V1\n');

    expect(port.fileIdAtPath(PATH_A)).toBe(FILE_A);
    expect(port.baseHashFor(FILE_A)).toBe('h1');
    expect(port.baseContentFor(FILE_A)).toBe('V1\n');
  });

  it('keeps the ancestor and its hash on one record', async () => {
    // The pair that used to live in two maps and drift apart.
    const { registry, port } = makePort();
    await port.recordPathOwner(FILE_A, PATH_A);
    await port.recordBaseHash(FILE_A, 'h1');
    await port.recordBaseContent(FILE_A, 'V1\n');

    const record = registry.byFileId(FILE_A);
    expect(record?.agreedHash).toBe('h1');
    expect(record?.agreedContent).toBe('V1\n');
  });

  it('forgets a file completely, leaving no half-state', async () => {
    const { port } = makePort();
    await port.recordPathOwner(FILE_A, PATH_A);
    await port.recordBaseHash(FILE_A, 'h1');
    await port.recordBaseContent(FILE_A, 'V1\n');

    await port.forgetPath(PATH_A);
    await port.forgetBaseHash(FILE_A);
    await port.forgetBaseContent(FILE_A);

    expect(port.fileIdAtPath(PATH_A)).toBeNull();
    expect(port.baseHashFor(FILE_A)).toBeNull();
    expect(port.baseContentFor(FILE_A)).toBeNull();
  });

  it('survives the six writes arriving in any order', async () => {
    // vault-apply.ts calls these in different sequences per branch; no order
    // may leave a record that reads back inconsistently.
    const { port } = makePort();
    await port.recordBaseContent(FILE_A, 'V1\n');
    await port.recordBaseHash(FILE_A, 'h1');
    await port.recordPathOwner(FILE_A, PATH_A);

    expect(port.fileIdAtPath(PATH_A)).toBe(FILE_A);
    expect(port.baseHashFor(FILE_A)).toBe('h1');
    expect(port.baseContentFor(FILE_A)).toBe('V1\n');
  });

  it('moves the path when a file is renamed', async () => {
    const { port } = makePort();
    await port.recordPathOwner(FILE_A, PATH_A);
    await port.recordBaseHash(FILE_A, 'h1');
    await port.recordPathOwner(FILE_A, 'Notes/b.md');

    expect(port.fileIdAtPath(PATH_A)).toBeNull();
    expect(port.fileIdAtPath('Notes/b.md')).toBe(FILE_A);
    // The base survives the move: it is keyed by file, not by path.
    expect(port.baseHashFor(FILE_A)).toBe('h1');
  });

  it('retires the previous owner when a path changes hands', async () => {
    const { port } = makePort();
    await port.recordPathOwner(FILE_A, PATH_A);
    await port.recordBaseHash(FILE_A, 'h1');
    await port.recordPathOwner('file-b', PATH_A);

    expect(port.fileIdAtPath(PATH_A)).toBe('file-b');
    // The displaced file is gone entirely, not left as an orphan base.
    expect(port.baseHashFor(FILE_A)).toBeNull();
  });

  it('reports nothing for a file it never saw', () => {
    const { port } = makePort();
    expect(port.fileIdAtPath('Notes/missing.md')).toBeNull();
    expect(port.baseHashFor('unknown')).toBeNull();
    expect(port.baseContentFor('unknown')).toBeNull();
  });

  it('tolerates forgetting something that was never recorded', async () => {
    const { port } = makePort();
    await expect(port.forgetPath('Notes/missing.md')).resolves.toBeUndefined();
    await expect(port.forgetBaseHash('unknown')).resolves.toBeUndefined();
    await expect(port.forgetBaseContent('unknown')).resolves.toBeUndefined();
  });
});

/**
 * The adopt case, as one call.
 *
 * When a path switches from a locally-minted fileId to the peer's, the old code
 * needed eight ordered calls and three comments explaining why the order
 * matters, because retiring the old owner had to happen strictly before
 * adopting the new one or the adopt would be undone. Expressed as one event,
 * the ordering hazard does not exist.
 */
describe('adoptPathUnderNewFile', () => {
  it('retires the previous owner and installs the new one', async () => {
    const { registry, port } = makePort();
    await port.recordPathOwner('old-file', PATH_A);
    await port.recordBaseHash('old-file', 'old-hash');
    await port.recordBaseContent('old-file', 'OLD\n');

    port.adoptPathUnderNewFile({
      fileId: FILE_A,
      path: PATH_A,
      content: 'SHARED\n',
      contentHash: 'shared-hash',
      headRevisionId: 'rev-1',
    });

    expect(port.fileIdAtPath(PATH_A)).toBe(FILE_A);
    expect(port.baseHashFor(FILE_A)).toBe('shared-hash');
    expect(port.baseContentFor(FILE_A)).toBe('SHARED\n');
    // No orphan left behind: the superseded fileId is gone entirely.
    expect(registry.byFileId('old-file')).toBeUndefined();
    expect([...registry.all()]).toHaveLength(1);
  });

  it('works when nothing owned the path before', async () => {
    const { port } = makePort();
    port.adoptPathUnderNewFile({
      fileId: FILE_A,
      path: PATH_A,
      content: 'REMOTE\n',
      contentHash: 'h',
      headRevisionId: 'rev-1',
    });
    expect(port.fileIdAtPath(PATH_A)).toBe(FILE_A);
    expect(port.baseContentFor(FILE_A)).toBe('REMOTE\n');
  });

  it('leaves the agreed pair consistent', async () => {
    const { registry, port } = makePort();
    port.adoptPathUnderNewFile({
      fileId: FILE_A,
      path: PATH_A,
      content: 'SHARED\n',
      contentHash: 'shared-hash',
      headRevisionId: 'rev-1',
    });
    const record = registry.byFileId(FILE_A);
    expect(record?.agreedContent).toBe('SHARED\n');
    expect(record?.agreedHash).toBe('shared-hash');
    expect(record?.headRevisionId).toBe('rev-1');
  });
});

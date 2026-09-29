import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { BlobHash, PlaintextHash } from './hashing.js';
import {
  canonicalJson,
  hashBlob,
  hashCanonicalJson,
  hashPlaintext,
  sha256Hex,
} from './hashing.js';

describe('hashing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches the standard SHA-256 vector for abc', async () => {
    await expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hands the caller\'s bytes to the digest as they are, without copying them first', async () => {
    // An attachment can be 25 MB, and a copy of it is a second 25 MB.
    const bytes = new Uint8Array(1024).fill(7);
    const digest = vi.spyOn(crypto.subtle, 'digest');

    await sha256Hex(bytes);

    expect(digest.mock.calls[0]?.[1]).toBe(bytes);
  });

  it('hashes only the window a subarray views, not the buffer behind it', async () => {
    const window = new TextEncoder().encode('abc');
    const behind = new Uint8Array(64).fill(9);
    behind.set(window, 10);

    await expect(sha256Hex(behind.subarray(10, 13))).resolves.toBe(
      await sha256Hex('abc'),
    );
  });

  it('serializes canonical object keys independently of insertion order', () => {
    const first = { z: 2, nested: { beta: true, alpha: 'é😀' }, a: 1 };
    const second = { a: 1, nested: { alpha: 'é😀', beta: true }, z: 2 };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJson(first)).toBe(
      '{"a":1,"nested":{"alpha":"é😀","beta":true},"z":2}',
    );
  });

  it('hashes canonical headers independently of property order', async () => {
    await expect(hashCanonicalJson({ b: 2, a: 'żółw' })).resolves.toBe(
      await hashCanonicalJson({ a: 'żółw', b: 2 }),
    );
  });

  it.each([
    { unsupported: undefined },
    { unsupported: Number.NaN },
    { unsupported: Number.POSITIVE_INFINITY },
  ])('rejects non-JSON or non-finite values: $unsupported', (value) => {
    expect(() => canonicalJson(value)).toThrow();
  });

  it('rejects sparse arrays, cycles and non-plain objects', () => {
    const sparse = new Array<unknown>(1);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => canonicalJson(sparse)).toThrow();
    expect(() => canonicalJson(cyclic)).toThrow();
    expect(() => canonicalJson(new Date(0))).toThrow();
  });

  it('hashes raw blob bytes but normalized plaintext Markdown', async () => {
    const blob = await hashBlob(new TextEncoder().encode('line\r\n'));
    const plaintext = await hashPlaintext('line\r\n');
    const normalizedBytes = await hashBlob(new TextEncoder().encode('line\n'));

    expect(plaintext).toBe(normalizedBytes);
    expect(blob).not.toBe(plaintext);
  });

  it('keeps blob and plaintext hashes distinct at the type level', async () => {
    expectTypeOf(await hashBlob(new Uint8Array())).toEqualTypeOf<BlobHash>();
    expectTypeOf(await hashPlaintext('')).toEqualTypeOf<PlaintextHash>();
    expectTypeOf<BlobHash>().not.toEqualTypeOf<PlaintextHash>();
  });
});

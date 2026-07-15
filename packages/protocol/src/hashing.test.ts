import { describe, expect, expectTypeOf, it } from 'vitest';

import type { BlobHash, PlaintextHash } from './hashing.js';
import {
  canonicalJson,
  hashBlob,
  hashCanonicalJson,
  hashPlaintext,
  sha256Hex,
} from './hashing.js';

describe('hashing', () => {
  it('matches the standard SHA-256 vector for abc', async () => {
    await expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
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

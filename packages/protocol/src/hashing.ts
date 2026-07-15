import { z } from 'zod';

import { canonicalizeMarkdown } from './canonicalization.js';

declare const blobHashBrand: unique symbol;
declare const plaintextHashBrand: unique symbol;

export type BlobHash = string & {
  readonly [blobHashBrand]: 'BlobHash';
};

export type PlaintextHash = string & {
  readonly [plaintextHashBrand]: 'PlaintextHash';
};

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const blobHashSchema = sha256HexSchema.transform(
  (value) => value as BlobHash,
);

export const plaintextHashSchema = sha256HexSchema.transform(
  (value) => value as PlaintextHash,
);

function serializeCanonical(
  value: unknown,
  ancestors: ReadonlySet<object>,
): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('Value is not JSON serializable.');
    }
    return serialized;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON does not support non-finite numbers.');
    }
    return JSON.stringify(value);
  }

  if (typeof value !== 'object') {
    throw new TypeError('Value is not JSON serializable.');
  }

  if (ancestors.has(value)) {
    throw new TypeError('Canonical JSON does not support cyclic values.');
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError('Canonical JSON does not support sparse arrays.');
      }
    }

    return `[${value
      .map((item) => serializeCanonical(item, nextAncestors))
      .join(',')}]`;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Canonical JSON supports plain objects only.');
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Canonical JSON does not support symbol keys.');
  }

  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeCanonical(record[key], nextAncestors)}`,
    );

  return `{${members.join(',')}}`;
}

export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set());
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function sha256Hex(
  input: string | Uint8Array,
): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', digestInput);
  return bytesToHex(new Uint8Array(digest));
}

export async function hashCanonicalJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

export async function hashBlob(bytes: Uint8Array): Promise<BlobHash> {
  return (await sha256Hex(bytes)) as BlobHash;
}

export async function hashPlaintext(content: string): Promise<PlaintextHash> {
  return (await sha256Hex(canonicalizeMarkdown(content))) as PlaintextHash;
}

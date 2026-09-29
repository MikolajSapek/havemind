import { bytesToBase64, canonicalizeVaultPath, isCanonicalBase64 } from '@havemind/protocol';
import { describe, expect, it } from 'vitest';

import { decodeRevisionPayload } from './payload-codec.js';
import {
  buildRevisionEnvelope,
  type BuildRevisionEnvelopeInput,
} from './revision-envelope.js';

const A = '55555555-5555-4555-8555-555555555555';
const B = '66666666-6666-4666-8666-666666666666';

/**
 * The decoding rules of the OLDEST released plugin, 1.0.0. Releases 1.0.0 to
 * 1.5.7 all ship this reader (`git show 1.0.0:packages/sync-core/src/
 * payload-codec.ts`; only comments changed since). It is frozen here on purpose:
 * it reads exactly these fields and nothing else, so a payload it accepts is a
 * payload every released plugin can decode. Never edit it to follow the current
 * decoder.
 */
function decodeAsPlugin100(bytes: Uint8Array): unknown {
  const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const operations = ['initial-import', 'create', 'update', 'rename', 'restore', 'reconcile', 'delete'];
  const path = (value: unknown): string => {
    if (typeof value !== 'string' || canonicalizeVaultPath(value) !== value) throw new Error('path');
    return value;
  };
  if (json.schemaVersion !== 1) throw new Error('schema version');
  if (typeof json.operation !== 'string' || !operations.includes(json.operation)) throw new Error('operation');
  const common = {
    operation: json.operation,
    path: path(json.path),
    previousPath: json.previousPath == null ? null : path(json.previousPath),
  };
  if (json.kind === 'binary') {
    if (typeof json.contentBase64 !== 'string' || !isCanonicalBase64(json.contentBase64)) throw new Error('base64');
    const binaryContent = Uint8Array.from(atob(json.contentBase64), (char) => char.charCodeAt(0));
    return { ...common, content: null, binaryContent };
  }
  if (json.operation === 'delete') {
    if (json.content != null) throw new Error('tombstone content');
    return { ...common, content: null, binaryContent: null };
  }
  if (typeof json.content !== 'string') throw new Error('content');
  return { ...common, content: json.content, binaryContent: null };
}

const CHANGES: ReadonlyArray<
  readonly [string, Pick<BuildRevisionEnvelopeInput, 'parentRevisionIds' | 'operation' | 'path' | 'content'> & Partial<BuildRevisionEnvelopeInput>]
> = [
  ['a create', { parentRevisionIds: [], operation: 'create', path: 'Notes/a.md', content: 'Hello\n' }],
  ['an update', { parentRevisionIds: [A], operation: 'update', path: 'Notes/a.md', content: 'Hello again\n' }],
  ['a merge, which still carries a recipe', { parentRevisionIds: [A, B], operation: 'update', path: 'Notes/a.md', content: 'ALPHA\nOMEGA\n' }],
  ['an empty note', { parentRevisionIds: [], operation: 'create', path: 'Notes/a.md', content: '' }],
  ['a rename', { parentRevisionIds: [A], operation: 'rename', path: 'Notes/b.md', previousPath: 'Notes/a.md', content: 'Hello\n' }],
  ['a delete tombstone', { parentRevisionIds: [A], operation: 'delete', path: 'Notes/a.md', content: null }],
  ['an attachment', { parentRevisionIds: [], operation: 'create', kind: 'binary', path: 'Attachments/pic.png', content: null, binaryContentBase64: bytesToBase64(new Uint8Array([0, 16, 255, 128, 127, 0, 171])) }],
];

describe('revision payload compatibility with released plugins', () => {
  it.each(CHANGES)('%s decodes under the 1.0.0 rules, as it does today', async (_name, change) => {
    const built = await buildRevisionEnvelope({
      identity: {
        vaultId: '11111111-1111-4111-8111-111111111111',
        fileId: '22222222-2222-4222-8222-222222222222',
        memberId: '33333333-3333-4333-8333-333333333333',
        deviceId: '44444444-4444-4444-8444-444444444444',
      },
      revisionId: '77777777-7777-4777-8777-777777777777',
      idempotencyKey: 'op',
      ...change,
    });
    const bytes = new Uint8Array(Buffer.from(built.payloadBase64, 'base64'));

    const old = decodeAsPlugin100(bytes);
    const current = decodeRevisionPayload(bytes);

    expect(old).toEqual({
      operation: current.operation,
      path: current.path,
      previousPath: current.previousPath,
      content: current.content,
      binaryContent: current.binaryContent ?? null,
    });
    expect(old).toMatchObject({ content: change.content });
  });

  it('decodes a payload written by a plugin that still stored the recipe', () => {
    // What releases 1.0.0 to 1.5.7 wrote for a note. Payloads like this stay on
    // the server for good, so the current decoder must keep reading them.
    const legacy = JSON.stringify({
      schemaVersion: 1,
      operation: 'update',
      path: 'Notes/a.md',
      content: 'Hello again\n',
      plaintextHash: 'a'.repeat(64),
      recipe: { version: 1, parts: [{ type: 'literal', text: 'Hello again\n' }] },
    });

    expect(decodeRevisionPayload(legacy)).toMatchObject({
      operation: 'update',
      path: 'Notes/a.md',
      content: 'Hello again\n',
    });
  });
});

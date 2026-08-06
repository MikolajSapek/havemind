import { describe, expect, it } from 'vitest';

import { decodeRevisionPayload, PayloadDecodeError } from './payload-codec';

function encode(value: unknown): string {
  return JSON.stringify(value);
}

const byteHash = 'b'.repeat(64);

describe('decodeRevisionPayload — binary', () => {
  it('decodes a binary revision to its raw bytes (0x00 and high bytes preserved)', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0x80, 0x00]);
    const contentBase64 = Buffer.from(bytes).toString('base64');

    const decoded = decodeRevisionPayload(
      encode({
        schemaVersion: 1,
        operation: 'create',
        kind: 'binary',
        path: 'Attachments/pic.png',
        contentBase64,
        blobByteHash: byteHash,
        recipe: null,
      }),
    );

    expect(decoded.kind).toBe('binary');
    expect(decoded.content).toBeNull();
    expect(decoded.operation).toBe('create');
    expect(decoded.path).toBe('Attachments/pic.png');
    expect([...(decoded.binaryContent ?? [])]).toEqual([...bytes]);
  });

  it('reports markdown kind and null binaryContent for a legacy content payload', () => {
    const decoded = decodeRevisionPayload(
      encode({
        schemaVersion: 1,
        operation: 'create',
        path: 'Notes/a.md',
        content: 'Hello\n',
        plaintextHash: 'sha256:x',
        recipe: { version: 1, parts: [] },
      }),
    );

    expect(decoded.kind).toBe('markdown');
    expect(decoded.binaryContent).toBeNull();
    expect(decoded.content).toBe('Hello\n');
  });

  it('decodes an empty binary file to a zero-length byte array', () => {
    const decoded = decodeRevisionPayload(
      encode({
        schemaVersion: 1,
        operation: 'create',
        kind: 'binary',
        path: 'Attachments/empty.pdf',
        contentBase64: '',
        blobByteHash: byteHash,
        recipe: null,
      }),
    );

    expect(decoded.kind).toBe('binary');
    expect(decoded.binaryContent).toEqual(new Uint8Array(0));
  });

  it('rejects a binary payload steering at a reserved vault root', () => {
    expect(() =>
      decodeRevisionPayload(
        encode({
          schemaVersion: 1,
          operation: 'create',
          kind: 'binary',
          // Denylisted under the `.obsidian/` mirror (our own plugin folder) —
          // stays reserved even though most `.obsidian/` config now syncs.
          path: '.obsidian/plugins/havemind-sync/evil.png',
          contentBase64: 'AAA=',
          blobByteHash: byteHash,
          recipe: null,
        }),
      ),
    ).toThrow(PayloadDecodeError);
  });

  it('rejects a binary payload with an invalid base64 body', () => {
    expect(() =>
      decodeRevisionPayload(
        encode({
          schemaVersion: 1,
          operation: 'create',
          kind: 'binary',
          path: 'Attachments/pic.png',
          contentBase64: 'not base64!!',
          blobByteHash: byteHash,
          recipe: null,
        }),
      ),
    ).toThrow(PayloadDecodeError);
  });
});

import { describe, expect, it } from 'vitest';

import { decodeRevisionPayload, PayloadDecodeError } from './payload-codec';

function encode(value: unknown): string {
  return JSON.stringify(value);
}

describe('decodeRevisionPayload', () => {
  it('decodes a content revision to its path and content', () => {
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
    expect(decoded).toEqual({
      operation: 'create',
      path: 'Notes/a.md',
      previousPath: null,
      kind: 'markdown',
      content: 'Hello\n',
      binaryContent: null,
    });
  });

  it('decodes a rename carrying its previous path', () => {
    const decoded = decodeRevisionPayload(
      encode({
        schemaVersion: 1,
        operation: 'rename',
        path: 'Notes/b.md',
        previousPath: 'Notes/a.md',
        content: 'Hello\n',
      }),
    );
    expect(decoded.operation).toBe('rename');
    expect(decoded.path).toBe('Notes/b.md');
    expect(decoded.previousPath).toBe('Notes/a.md');
  });

  it('decodes a delete tombstone with null content', () => {
    const decoded = decodeRevisionPayload(
      encode({ schemaVersion: 1, operation: 'delete', path: 'Notes/a.md', content: null }),
    );
    expect(decoded.operation).toBe('delete');
    expect(decoded.content).toBeNull();
  });

  it('accepts raw bytes as well as a string', () => {
    const bytes = new TextEncoder().encode(
      encode({ schemaVersion: 1, operation: 'create', path: 'Notes/a.md', content: 'Hi\n' }),
    );
    expect(decodeRevisionPayload(bytes).content).toBe('Hi\n');
  });

  it('rejects invalid JSON', () => {
    expect(() => decodeRevisionPayload('not json')).toThrow(PayloadDecodeError);
  });

  it('rejects an unknown operation', () => {
    expect(() =>
      decodeRevisionPayload(
        encode({ schemaVersion: 1, operation: 'nuke', path: 'Notes/a.md', content: 'x\n' }),
      ),
    ).toThrow(PayloadDecodeError);
  });

  it('rejects a reserved or non-canonical vault path', () => {
    expect(() =>
      decodeRevisionPayload(
        encode({
          schemaVersion: 1,
          operation: 'create',
          path: 'Havemind Conflicts/x.md',
          content: 'x\n',
        }),
      ),
    ).toThrow(PayloadDecodeError);
    expect(() =>
      decodeRevisionPayload(
        encode({ schemaVersion: 1, operation: 'create', path: '../escape.md', content: 'x\n' }),
      ),
    ).toThrow(PayloadDecodeError);
  });

  it('rejects a content revision whose content is not a string', () => {
    expect(() =>
      decodeRevisionPayload(
        encode({ schemaVersion: 1, operation: 'create', path: 'Notes/a.md', content: null }),
      ),
    ).toThrow(PayloadDecodeError);
  });
});

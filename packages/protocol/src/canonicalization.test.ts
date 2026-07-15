import { describe, expect, it } from 'vitest';

import {
  canonicalizeMarkdown,
  canonicalizeVaultPath,
  isReservedVaultPath,
  pathCollisionKey,
  utf16Length,
} from './canonicalization.js';

describe('canonicalization', () => {
  it('normalizes CRLF and lone CR to LF without normalizing content Unicode', () => {
    const decomposed = 'Cafe\u0301';

    expect(canonicalizeMarkdown(`a\r\n${decomposed}\rb`)).toBe(
      `a\n${decomposed}\nb`,
    );
  });

  it('reports JavaScript and CodeMirror UTF-16 code-unit length', () => {
    expect(utf16Length('A😀e\u0301')).toBe(5);
  });

  it('normalizes valid vault paths to NFC and slash separators', () => {
    expect(canonicalizeVaultPath('Notes/Cafe\u0301.md')).toBe(
      'Notes/Café.md',
    );
  });

  it.each([
    '',
    '/absolute.md',
    'C:/absolute.md',
    'C:drive-relative.md',
    '../escape.md',
    'Notes/../escape.md',
    'Notes/./entry.md',
    'Notes//entry.md',
    'Notes/entry.md/',
    'Notes\\entry.md',
    'Notes/\u0000entry.md',
    'Notes/line\nbreak.md',
    'Notes/control\u0085.md',
  ])('rejects ambiguous, absolute, traversal or control paths: %s', (path) => {
    expect(() => canonicalizeVaultPath(path)).toThrow();
  });

  it.each([
    '.obsidian/plugins/example/data.json',
    '.TRASH/Deleted.md',
    'Havemind Conflicts/Plan--conflict.md',
  ])('recognizes reserved paths case-insensitively: %s', (path) => {
    expect(isReservedVaultPath(path)).toBe(true);
    expect(() => canonicalizeVaultPath(path)).toThrow(/reserved/i);
  });

  it('creates the same lowercase NFC collision key for unsafe aliases', () => {
    expect(pathCollisionKey('Notes/CAFÉ.md')).toBe(
      pathCollisionKey('notes/Cafe\u0301.md'),
    );
  });
});

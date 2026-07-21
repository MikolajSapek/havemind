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
      `a\n${decomposed}\nb\n`,
    );
  });

  it('ensures exactly one trailing newline at EOF', () => {
    expect(canonicalizeMarkdown('a')).toBe('a\n');
    expect(canonicalizeMarkdown('a\n')).toBe('a\n');
    expect(canonicalizeMarkdown('a\n\n\n')).toBe('a\n');
    expect(canonicalizeMarkdown('a\r\n\r\n')).toBe('a\n');
  });

  it('keeps an empty (or newline-only) file empty', () => {
    expect(canonicalizeMarkdown('')).toBe('');
    expect(canonicalizeMarkdown('\n')).toBe('');
    expect(canonicalizeMarkdown('\r\n\r\n')).toBe('');
  });

  it('strips a leading UTF-8 BOM but never an interior one', () => {
    expect(canonicalizeMarkdown('\ufeffhello')).toBe('hello\n');
    expect(canonicalizeMarkdown('a\ufeffb')).toBe('a\ufeffb\n');
  });

  it('does not touch intra-line spacing, quotes or list markers', () => {
    const body = '-  item   with  spaces\n> "quote"  ';
    expect(canonicalizeMarkdown(body)).toBe(`${body}\n`);
  });

  it('is idempotent', () => {
    const inputs = ['a', 'a\n', '\ufeffa\r\n\r\n', '', '\n', 'x\ny\n\n'];
    for (const input of inputs) {
      const once = canonicalizeMarkdown(input);
      expect(canonicalizeMarkdown(once)).toBe(once);
    }
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

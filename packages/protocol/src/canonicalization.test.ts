import { describe, expect, it } from 'vitest';

import { pathExtension } from './appearance-scope.js';
import {
  canonicalizeMarkdown,
  canonicalizeVaultPath,
  CONFLICT_FOLDER,
  SYNCABLE_BINARY_EXTENSIONS,
  syncContentKind,
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
    expect(() => canonicalizeVaultPath(path)).toThrow(/reserved/i);
  });
});

// The rules for which paths sync live here, next to the reserved roots they
// must agree with. The plugin asks; it decides nothing of its own. The full
// table across both layers is tests/vault-path-policy.test.ts.
describe('syncContentKind', () => {
  it.each([
    ['Notes/Plan.md', 'markdown'],
    ['Notes/PLAN.MD', 'markdown'],
    ['Attachments/pic.PNG', 'binary'],
    ['Attachments/paper.pdf', 'binary'],
    ['.obsidian/appearance.json', 'markdown'],
    ['.obsidian/snippets/tweaks.css', 'markdown'],
    ['.obsidian/themes/Minimal/theme.css', 'markdown'],
    ['.obsidian/themes/Minimal/preview.png', 'binary'],
  ])('carries %s as %s', (path, kind) => {
    expect(syncContentKind(path)).toBe(kind);
  });

  it('carries every allowlisted attachment extension as binary, in any case', () => {
    for (const extension of SYNCABLE_BINARY_EXTENSIONS) {
      expect(syncContentKind(`a/b.${extension}`)).toBe('binary');
      expect(syncContentKind(`a/b.${extension.toUpperCase()}`)).toBe('binary');
    }
  });

  it.each([
    'Notes/archive.zip',
    'Notes/no-extension',
    'Notes/.md',
    // A dot-segment never syncs, wherever it sits.
    '.hidden/x.md',
    'Notes/.drafts/x.md',
    '.trash/x.md',
    '.obsidian/plugins/x/main.js',
    // Inside the allowlist, only the admitted shapes and formats.
    '.obsidian/themes/Minimal/evil.js',
    '.obsidian/themes/Minimal/paper.pdf',
    '.obsidian/themes/Minimal/data.json',
    '.obsidian/snippets/nested/tweaks.css',
    // Not a path at all.
    '/absolute.md',
    'Notes//double.md',
    '../escape.md',
  ])('keeps %s on the machine', (path) => {
    expect(syncContentKind(path)).toBeNull();
  });

  it('excludes the conflict folder under the name the wire reserves', () => {
    // One constant behind both answers: a copy the apply side writes there
    // must never sync back, and must never be accepted from a peer.
    for (const folder of [
      CONFLICT_FOLDER,
      CONFLICT_FOLDER.toLowerCase(),
      CONFLICT_FOLDER.toUpperCase(),
    ]) {
      expect(syncContentKind(`${folder}/x.md`)).toBeNull();
      expect(() => canonicalizeVaultPath(`${folder}/x.md`)).toThrow(/reserved/i);
    }
    expect(syncContentKind(`${CONFLICT_FOLDER} Archive/x.md`)).toBe('markdown');
    expect(syncContentKind(`Notes/${CONFLICT_FOLDER}/x.md`)).toBe('markdown');
  });
});

describe('pathExtension', () => {
  it.each([
    ['Notes/a.md', 'md'],
    ['Notes/A.PNG', 'png'],
    ['a.tar.gz', 'gz'],
    ['Notes.v2/file', ''],
    ['Notes/.gitignore', ''],
    ['Notes/trailing.', ''],
    ['Notes/none', ''],
    ['', ''],
  ])('reads the extension of %j as %j', (path, extension) => {
    expect(pathExtension(path)).toBe(extension);
  });
});

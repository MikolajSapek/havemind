import { isSyncableConfigPath } from './appearance-scope.js';

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:/u;
const RESERVED_ROOTS = new Set([
  '.obsidian',
  '.trash',
  'havemind conflicts',
]);

/**
 * Canonical form of note content used for HASHING and DIFF BASES only — never
 * written back to disk (a user's file stays byte-exact as received). The
 * transform is deliberately CONSERVATIVE so it can never mask a real edit:
 *  1. strip a leading UTF-8 BOM (an interior U+FEFF is left untouched);
 *  2. normalize CRLF and lone CR to LF;
 *  3. collapse trailing blank lines to exactly one final LF (an empty — or
 *     newline-only — file stays empty).
 * Nothing intra-line (quotes, list markers, spacing) is normalized; that would
 * hide genuine content changes. The transform is idempotent.
 *
 * Rationale (AUD-03): a formatter plugin rewriting a note after Havemind's apply
 * differs from the seeded hash only by line endings, a BOM or trailing newlines,
 * which would otherwise be pushed as a spurious revision and oscillate forever
 * between two machines with different formatter settings.
 */
export function canonicalizeMarkdown(content: string): string {
  const withoutBom =
    content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lf = withoutBom.replace(/\r\n?/gu, '\n');
  const withoutTrailingNewlines = lf.replace(/\n+$/u, '');
  return withoutTrailingNewlines.length === 0
    ? ''
    : `${withoutTrailingNewlines}\n`;
}

export function utf16Length(content: string): number {
  return content.length;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }

  return false;
}

function normalizedVaultPath(path: string): string {
  if (path.length === 0) {
    throw new Error('Vault path must not be empty.');
  }

  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    WINDOWS_DRIVE_PATH.test(path)
  ) {
    throw new Error('Vault path must be relative and use forward slashes.');
  }

  if (containsControlCharacter(path)) {
    throw new Error('Vault path must not contain control characters.');
  }

  const normalized = path.normalize('NFC');
  const segments = normalized.split('/');

  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new Error('Vault path contains an empty or traversal segment.');
  }

  return normalized;
}

function reservedRoot(path: string): boolean {
  const [root] = path.split('/');
  if (root === undefined || !RESERVED_ROOTS.has(root.toLowerCase())) {
    return false;
  }
  // Exception: the `.obsidian/` APPEARANCE ALLOWLIST is permitted to cross the
  // sync boundary — only the explicit set named inside `isSyncableConfigPath`
  // (`appearance.json`, `app.json`, `hotkeys.json`, `core-plugins.json`,
  // `snippets/<name>.css`, `themes/<name>/…`). Everything else under
  // `.obsidian/` stays reserved and is rejected here at build, decode and
  // schema-validation alike — notably ALL of `.obsidian/plugins/**`, so a
  // plugin-code revision authored by an older peer fails validation on arrival
  // instead of being written to disk (audit #3 finding 2). `.trash` and
  // `Havemind Conflicts/` are never under `.obsidian/`, so they stay reserved.
  if (isSyncableConfigPath(path)) {
    return false;
  }
  return true;
}

export function isReservedVaultPath(path: string): boolean {
  try {
    return reservedRoot(normalizedVaultPath(path));
  } catch {
    return false;
  }
}

export function canonicalizeVaultPath(path: string): string {
  const normalized = normalizedVaultPath(path);

  if (reservedRoot(normalized)) {
    throw new Error('Vault path uses a reserved Havemind root.');
  }

  return normalized;
}

export function pathCollisionKey(path: string): string {
  return canonicalizeVaultPath(path).toLowerCase();
}

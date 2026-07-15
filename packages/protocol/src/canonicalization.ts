const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:/u;
const RESERVED_ROOTS = new Set([
  '.obsidian',
  '.trash',
  'havemind conflicts',
]);

export function canonicalizeMarkdown(content: string): string {
  return content.replace(/\r\n?/gu, '\n');
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
  return root !== undefined && RESERVED_ROOTS.has(root.toLowerCase());
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

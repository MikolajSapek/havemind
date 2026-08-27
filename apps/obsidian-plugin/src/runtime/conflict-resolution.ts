/**
 * MRG-03, in-app conflict-copy resolution.
 *
 * A conflict copy is a divergent revision the apply path could not converge
 * (see vault-apply.ts). Copies live under the reserved `Havemind Conflicts/`
 * folder, which is excluded from sync, so every file operation here is purely
 * local, deleting a resolved copy never leaves the vault, and writing "theirs"
 * into the live note is a normal local edit the producer will sync.
 *
 * This module is pure DI: all vault access flows through {@link ConflictVaultPort}
 * so the parsing, pairing, diff and resolve logic is unit-testable without
 * Obsidian. `main.ts` supplies an Obsidian-backed port at runtime.
 */

import type { TFile, Vault } from 'obsidian';

/**
 * Reserved, sync-excluded folder holding conflict copies, the SINGLE definition
 * of the name. Three sites depend on it agreeing exactly: this resolution flow,
 * the producer's reserved-root exclusion (`obsidian/vault-adapter.ts`) and the
 * apply adapter's `conflictFolder` (`runtime/obsidian-adapters.ts`). All three
 * import it from here; a private duplicate would let the exclusion drift away
 * from the folder that is actually written to, and every conflict copy would then
 * sync back as an ordinary note.
 */
export const CONFLICT_FOLDER = 'Havemind Conflicts';

/** A single UUID (8-4-4-4-12 hex). Legacy copies are two of these joined. */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const LEGACY_UUID_RE = new RegExp(`^${UUID}-${UUID}$`);

/**
 * Matches the ` (conflict <author> <YYYY-MM-DD HHmm>)` suffix on a name with
 * its extension already stripped. The author group is greedy but the
 * fixed-shape timestamp at the very end anchors it, so multi-word authors and
 * Polish diacritics (any non-`)` characters) parse correctly.
 */
const NEW_SUFFIX_RE = / \(conflict (.+) (\d{4}-\d{2}-\d{2} \d{4})\)$/;

export interface ParsedConflictName {
  readonly kind: 'new' | 'legacy';
  /** Extension without the dot, e.g. `md` or `png`. */
  readonly extension: string;
  /** True when the copy is not markdown (resolved by opening files manually). */
  readonly isBinary: boolean;
  /** Target note basename (no extension) for new-format names; null for legacy. */
  readonly noteBasename: string | null;
  readonly author: string | null;
  /** Human-readable stamp `YYYY-MM-DD HHmm`, or null for legacy. */
  readonly timestamp: string | null;
}

/** Splits a leaf filename into its base and extension (without the dot). */
function splitExtension(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { base: name, extension: '' };
  return { base: name.slice(0, dot), extension: name.slice(dot + 1) };
}

/**
 * Parses a conflict-copy filename per the fixed naming contract. Returns null
 * for any name that is neither a new-format nor a legacy UUID conflict copy,
 * the reserved folder should only contain copies, but unknown names are skipped
 * rather than trusted.
 */
export function parseConflictCopyName(name: string): ParsedConflictName | null {
  const { base, extension } = splitExtension(name);
  const isBinary = extension.toLowerCase() !== 'md';

  const match = NEW_SUFFIX_RE.exec(base);
  if (match) {
    const noteBasename = base.slice(0, base.length - match[0].length);
    if (noteBasename.length === 0) return null;
    return {
      kind: 'new',
      extension,
      isBinary,
      noteBasename,
      author: match[1] ?? null,
      timestamp: match[2] ?? null,
    };
  }

  if (LEGACY_UUID_RE.test(base)) {
    return {
      kind: 'legacy',
      extension,
      isBinary,
      noteBasename: null,
      author: null,
      timestamp: null,
    };
  }

  return null;
}

/** A vault file the port can enumerate. */
export interface ConflictVaultFile {
  /** Vault-relative path (any depth). */
  readonly path: string;
  /** Leaf filename including extension. */
  readonly name: string;
}

/**
 * Minimal vault surface the resolution flow needs. All operations are scoped to
 * local files; the port implementation binds these to the Obsidian Vault API.
 */
export interface ConflictVaultPort {
  /** Files directly under the reserved conflict folder. */
  listConflictFiles(): ConflictVaultFile[];
  /** Candidate target notes (everything outside the conflict folder). */
  listNoteFiles(): ConflictVaultFile[];
  /** True when a file still exists at `path` (used to guard keepTheirs). */
  exists(path: string): Promise<boolean>;
  /**
   * Reads `path`, or null when the file is absent (MINOR 6). Signalling absence
   * as null, never as '', is what closes the exists→read TOCTOU: a copy
   * deleted between the guard and the read now returns null and aborts
   * keepTheirs, instead of reading '' and blanking the live note.
   */
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
}

export interface ConflictCopy {
  readonly copyPath: string;
  readonly copyName: string;
  readonly kind: 'new' | 'legacy';
  /** Display name of the target note (basename), or null when not derivable. */
  readonly noteName: string | null;
  readonly author: string | null;
  readonly timestamp: string | null;
  readonly isBinary: boolean;
  /** Resolved unique target path, or null when unknown/ambiguous/legacy. */
  readonly targetPath: string | null;
  readonly targetKnown: boolean;
  /** Non-null when the user must open the files manually. */
  readonly manualHint: string | null;
}

const MANUAL_HINT = 'Target unknown, open files manually.';

/**
 * Lists every parseable conflict copy in the reserved folder, paired with its
 * target note. New-format copies pair by searching all notes for a matching
 * leaf filename; 0 or >1 candidates (ambiguous) yield a manual hint. Legacy
 * UUID copies have no derivable target and always carry the hint.
 */
export function listConflictCopies(port: ConflictVaultPort): ConflictCopy[] {
  const notes = port.listNoteFiles();
  const copies: ConflictCopy[] = [];

  for (const file of port.listConflictFiles()) {
    const parsed = parseConflictCopyName(file.name);
    if (parsed === null) continue;

    if (parsed.kind === 'legacy') {
      copies.push({
        copyPath: file.path,
        copyName: file.name,
        kind: 'legacy',
        noteName: null,
        author: null,
        timestamp: null,
        isBinary: parsed.isBinary,
        targetPath: null,
        targetKnown: false,
        manualHint: MANUAL_HINT,
      });
      continue;
    }

    const targetLeaf = `${parsed.noteBasename}.${parsed.extension}`;
    const candidates = notes.filter((note) => note.name === targetLeaf);
    const unique = candidates.length === 1 ? candidates[0] : undefined;

    copies.push({
      copyPath: file.path,
      copyName: file.name,
      kind: 'new',
      noteName: parsed.noteBasename,
      author: parsed.author,
      timestamp: parsed.timestamp,
      isBinary: parsed.isBinary,
      targetPath: unique?.path ?? null,
      targetKnown: unique !== undefined,
      manualHint: unique !== undefined ? null : MANUAL_HINT,
    });
  }

  copies.sort((a, b) => a.copyName.localeCompare(b.copyName));
  return copies;
}

export type DiffLineType = 'context' | 'added' | 'removed';

export interface DiffLine {
  readonly type: DiffLineType;
  readonly text: string;
}

/** Splits text into lines, normalising CRLF so Windows copies compare cleanly. */
function toLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Computes a line-level diff between the live note (`mine`) and the conflict
 * copy (`theirs`) using a longest-common-subsequence backtrace. Removed lines
 * are present in `mine` only; added lines are present in `theirs` only. Kept
 * intentionally small, no dependency, self-contained.
 */
export function computeLineDiff(mine: string, theirs: string): DiffLine[] {
  const a = toLines(mine);
  const b = toLines(theirs);
  const n = a.length;
  const m = b.length;
  const width = m + 1;

  // lcs[i * width + j] = LCS length of a[i..] and b[j..]. A flat Int32Array
  // keeps every access typed as `number` (no index-undefined assertions).
  const lcs = new Int32Array((n + 1) * width);
  const get = (idx: number): number => lcs[idx] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? get((i + 1) * width + (j + 1)) + 1
          : Math.max(get((i + 1) * width + j), get(i * width + (j + 1)));
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] ?? '';
    const bj = b[j] ?? '';
    if (ai === bj) {
      diff.push({ type: 'context', text: ai });
      i++;
      j++;
    } else if (get((i + 1) * width + j) >= get(i * width + (j + 1))) {
      diff.push({ type: 'removed', text: ai });
      i++;
    } else {
      diff.push({ type: 'added', text: bj });
      j++;
    }
  }
  while (i < n) diff.push({ type: 'removed', text: a[i++] ?? '' });
  while (j < m) diff.push({ type: 'added', text: b[j++] ?? '' });
  return diff;
}

export type ResolveAction = 'keepMine' | 'keepTheirs' | 'keepBoth';

export type ResolveOutcome = 'resolved' | 'ignored' | 'vanished';

export interface ConflictResolver {
  /**
   * Runs a resolve action against the port. Returns:
   *  - `'resolved'` when it ran;
   *  - `'ignored'` when this copy was already being resolved, the guard makes
   *    a double click (or a stray second click before the list refreshes) safe:
   *    each destructive port op fires at most once per copy;
   *  - `'vanished'` when a keepTheirs was asked to apply a copy the auto-sweep
   *    had already resolved and deleted. The copy no longer exists, so applying
   *    it would read '' and blank the (already-merged) live note, DATA LOSS.
   *    The caller surfaces a Notice ("already auto-resolved") and refreshes.
   */
  resolve(copy: ConflictCopy, action: ResolveAction): Promise<ResolveOutcome>;
}

export function createConflictResolver(port: ConflictVaultPort): ConflictResolver {
  // Copies whose resolution has started (or finished). Never cleared: once a
  // copy is resolved its row disappears on refresh, so re-resolving is a bug.
  const settled = new Set<string>();

  return {
    async resolve(copy, action): Promise<ResolveOutcome> {
      if (settled.has(copy.copyPath)) return 'ignored';
      settled.add(copy.copyPath);

      switch (action) {
        case 'keepMine':
          // Discard the copy; the live note is already what we want. If the
          // sweep already deleted it, deleteFile is a graceful no-op.
          await port.deleteFile(copy.copyPath);
          break;
        case 'keepTheirs': {
          // Overwrite the note with the copy, then discard the copy. A missing
          // target cannot be written; guard rather than throwing mid-UI.
          if (copy.targetPath === null) {
            await port.deleteFile(copy.copyPath);
            break;
          }
          // DATA-LOSS GUARD: the auto-sweep may have resolved and deleted this
          // copy in the meantime. A vanished copy reads as '' and would blank
          // the (already-merged) live note. Verify the copy still exists before
          // reading/writing; if not, abort so the caller can tell the user it
          // was already auto-resolved and refresh the stale panel/modal.
          if (!(await port.exists(copy.copyPath))) {
            return 'vanished';
          }
          // MINOR 6: the read itself is the authoritative absence signal,
          // exists() above is belt-and-braces, but a copy deleted between the
          // guard and the read returns null here and aborts, never reading '' and
          // blanking the merged note (the exists→read TOCTOU, closed for good).
          const content = await port.readText(copy.copyPath);
          if (content === null) {
            return 'vanished';
          }
          await port.writeText(copy.targetPath, content);
          await port.deleteFile(copy.copyPath);
          break;
        }
        case 'keepBoth':
          // Leave both files in place, no vault mutation.
          break;
      }
      return 'resolved';
    },
  };
}

/**
 * Binds {@link ConflictVaultPort} to the Obsidian Vault API. All reads/writes
 * go through the byte-level vault so deletion of a resolved copy is purely local
 * (the reserved folder is excluded from sync), and writing "theirs" into a note
 * is a normal local edit. Defensive about a vault stub lacking `getFiles` so it
 * degrades to "no conflicts" rather than throwing in headless contexts.
 */
export function createObsidianConflictPort(vault: Vault): ConflictVaultPort {
  const inReservedFolder = (path: string): boolean =>
    path === CONFLICT_FOLDER || path.startsWith(`${CONFLICT_FOLDER}/`);

  const allFiles = (): ConflictVaultFile[] => {
    if (typeof vault.getFiles !== 'function') return [];
    return vault.getFiles().map((file) => ({ path: file.path, name: file.name }));
  };

  return {
    listConflictFiles: () =>
      allFiles().filter((file) => inReservedFolder(file.path)),
    listNoteFiles: () =>
      allFiles().filter((file) => !inReservedFolder(file.path)),
    exists: async (path) => vault.getAbstractFileByPath(path) !== null,
    readText: async (path) => {
      const file = vault.getAbstractFileByPath(path);
      // MINOR 6: null (not '') signals a genuinely absent file, so a caller can
      // distinguish "missing" from "present but empty".
      if (file === null) return null;
      return vault.read(file as TFile);
    },
    writeText: async (path, content) => {
      const file = vault.getAbstractFileByPath(path);
      if (file === null) return;
      await vault.modify(file as TFile, content);
    },
    deleteFile: async (path) => {
      const file = vault.getAbstractFileByPath(path);
      if (file === null) return;
      await vault.delete(file);
    },
  };
}

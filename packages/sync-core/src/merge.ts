import { diffChars } from 'diff';

import {
  validateReconstruction,
  type ParentSnapshot,
  type ReconstructionPart,
  type ReconstructionRecipe,
} from './recipe.js';

interface Edit {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly replacement: string;
  readonly variantStart: number;
  readonly variantEnd: number;
  readonly source: ParentSnapshot;
}

export interface MergedSnapshot {
  readonly kind: 'merged';
  readonly content: string;
  readonly provenance: ReturnType<typeof validateReconstruction>['provenance'];
  readonly recipe: ReconstructionRecipe;
}

export interface MergeConflict {
  readonly kind: 'conflict';
  readonly reason: 'OVERLAPPING_EDITS';
  readonly leftRevisionId: string;
  readonly rightRevisionId: string;
}

export type MergeResult = MergedSnapshot | MergeConflict;

export interface FileVersionState {
  readonly path: string;
  readonly content: string | null;
}

export type FileConflictKind = 'EDIT_DELETE' | 'RENAME_RENAME';

/**
 * Classifies structural conflicts that cannot be resolved by the text merge.
 * An unchanged sibling does not turn a delete into a conflict.
 */
export function classifyFileConflict(
  base: FileVersionState,
  left: FileVersionState,
  right: FileVersionState,
): FileConflictKind | null {
  const leftDeleted = left.content === null;
  const rightDeleted = right.content === null;

  if (leftDeleted !== rightDeleted) {
    const survivor = leftDeleted ? right : left;
    const survivorChanged =
      survivor.content !== base.content || survivor.path !== base.path;
    return survivorChanged ? 'EDIT_DELETE' : null;
  }

  if (leftDeleted && rightDeleted) {
    return null;
  }

  const leftRenamed = left.path !== base.path;
  const rightRenamed = right.path !== base.path;
  if (leftRenamed && rightRenamed && left.path !== right.path) {
    return 'RENAME_RENAME';
  }

  return null;
}

function extractEdits(base: string, variant: ParentSnapshot): Edit[] {
  const edits: Edit[] = [];
  let baseOffset = 0;
  let variantOffset = 0;
  let active:
    | {
        baseStart: number;
        baseEnd: number;
        variantStart: number;
        variantEnd: number;
        replacement: string;
      }
    | undefined;

  const flush = (): void => {
    if (active === undefined) {
      return;
    }
    edits.push({ ...active, source: variant });
    active = undefined;
  };

  for (const change of diffChars(base, variant.content)) {
    const length = change.value.length;

    if (change.added !== true && change.removed !== true) {
      flush();
      baseOffset += length;
      variantOffset += length;
      continue;
    }

    active ??= {
      baseStart: baseOffset,
      baseEnd: baseOffset,
      variantStart: variantOffset,
      variantEnd: variantOffset,
      replacement: '',
    };

    if (change.removed === true) {
      baseOffset += length;
      active.baseEnd = baseOffset;
    } else {
      variantOffset += length;
      active.variantEnd = variantOffset;
      active.replacement += change.value;
    }
  }
  flush();

  return edits;
}

function editsAreIdentical(left: Edit, right: Edit): boolean {
  return (
    left.baseStart === right.baseStart &&
    left.baseEnd === right.baseEnd &&
    left.replacement === right.replacement
  );
}

function editsOverlap(left: Edit, right: Edit): boolean {
  if (editsAreIdentical(left, right)) {
    return false;
  }

  const leftIsInsertion = left.baseStart === left.baseEnd;
  const rightIsInsertion = right.baseStart === right.baseEnd;

  if (leftIsInsertion && rightIsInsertion) {
    return left.baseStart === right.baseStart;
  }

  if (leftIsInsertion) {
    return left.baseStart >= right.baseStart && left.baseStart <= right.baseEnd;
  }

  if (rightIsInsertion) {
    return right.baseStart >= left.baseStart && right.baseStart <= left.baseEnd;
  }

  return (
    Math.max(left.baseStart, right.baseStart) <
    Math.min(left.baseEnd, right.baseEnd)
  );
}

function editOrder(left: Edit, right: Edit): number {
  if (left.baseStart !== right.baseStart) {
    return left.baseStart - right.baseStart;
  }
  if (left.baseEnd !== right.baseEnd) {
    return left.baseEnd - right.baseEnd;
  }
  return left.source.revisionId < right.source.revisionId ? -1 : 1;
}

function combineEdits(left: readonly Edit[], right: readonly Edit[]): Edit[] | null {
  for (const leftEdit of left) {
    for (const rightEdit of right) {
      if (editsOverlap(leftEdit, rightEdit)) {
        return null;
      }
    }
  }

  const combined: Edit[] = [];
  for (const edit of [...left, ...right].sort(editOrder)) {
    const identicalIndex = combined.findIndex((candidate) =>
      editsAreIdentical(candidate, edit),
    );

    if (identicalIndex === -1) {
      combined.push(edit);
      continue;
    }

    const existing = combined[identicalIndex];
    if (
      existing !== undefined &&
      edit.source.revisionId < existing.source.revisionId
    ) {
      combined[identicalIndex] = edit;
    }
  }

  return combined.sort(editOrder);
}

function applyEdits(base: string, edits: readonly Edit[]): string {
  const output: string[] = [];
  let cursor = 0;

  for (const edit of edits) {
    output.push(base.slice(cursor, edit.baseStart), edit.replacement);
    cursor = edit.baseEnd;
  }
  output.push(base.slice(cursor));
  return output.join('');
}

function mapBaseBoundary(
  offset: number,
  edits: readonly Edit[],
  bias: 'before' | 'after',
): number {
  let mapped = offset;

  for (const edit of edits) {
    if (edit.baseEnd < offset) {
      mapped += edit.replacement.length - (edit.baseEnd - edit.baseStart);
      continue;
    }

    if (edit.baseEnd === offset) {
      const isInsertion = edit.baseStart === edit.baseEnd;
      if (!isInsertion || bias === 'after') {
        mapped += edit.replacement.length - (edit.baseEnd - edit.baseStart);
      }
      continue;
    }

    if (edit.baseStart < offset && offset < edit.baseEnd) {
      throw new Error('Cannot map a base boundary inside an edited range.');
    }

    if (edit.baseStart >= offset) {
      break;
    }
  }

  return mapped;
}

function appendSource(
  parts: ReconstructionPart[],
  parentRevisionId: string,
  start: number,
  end: number,
): void {
  if (start === end) {
    return;
  }

  const previous = parts.at(-1);
  if (
    previous?.type === 'source' &&
    previous.parentRevisionId === parentRevisionId &&
    previous.end === start
  ) {
    parts[parts.length - 1] = { ...previous, end };
    return;
  }

  parts.push({ type: 'source', parentRevisionId, start, end });
}

function buildMergeRecipe(
  base: ParentSnapshot,
  primary: ParentSnapshot,
  primaryEdits: readonly Edit[],
  edits: readonly Edit[],
): ReconstructionRecipe {
  const parts: ReconstructionPart[] = [];
  let baseCursor = 0;

  for (const edit of edits) {
    if (baseCursor < edit.baseStart) {
      appendSource(
        parts,
        primary.revisionId,
        mapBaseBoundary(baseCursor, primaryEdits, 'after'),
        mapBaseBoundary(edit.baseStart, primaryEdits, 'before'),
      );
    }

    appendSource(
      parts,
      edit.source.revisionId,
      edit.variantStart,
      edit.variantEnd,
    );
    baseCursor = edit.baseEnd;
  }

  if (baseCursor < base.content.length) {
    appendSource(
      parts,
      primary.revisionId,
      mapBaseBoundary(baseCursor, primaryEdits, 'after'),
      mapBaseBoundary(base.content.length, primaryEdits, 'before'),
    );
  }

  return { version: 1, parts };
}

export function mergeSnapshots(
  base: ParentSnapshot,
  first: ParentSnapshot,
  second: ParentSnapshot,
  mergeRevisionId: string,
): MergeResult {
  const [left, right] =
    first.revisionId < second.revisionId ? [first, second] : [second, first];
  const leftEdits = extractEdits(base.content, left);
  const rightEdits = extractEdits(base.content, right);
  const combined = combineEdits(leftEdits, rightEdits);

  if (combined === null) {
    return {
      kind: 'conflict',
      reason: 'OVERLAPPING_EDITS',
      leftRevisionId: left.revisionId,
      rightRevisionId: right.revisionId,
    };
  }

  const content = applyEdits(base.content, combined);
  const recipe = buildMergeRecipe(base, left, leftEdits, combined);
  const reconstructed = validateReconstruction(
    recipe,
    [left, right],
    content,
    mergeRevisionId,
  );

  return { kind: 'merged', recipe, ...reconstructed };
}

import { diffChars } from 'diff';

import { assertValidProvenance } from './provenance.js';
import {
  validateReconstruction,
  type ParentSnapshot,
  type ReconstructionPart,
  type ReconstructionRecipe,
} from './recipe.js';

const DEFAULT_MAX_TEXT_LENGTH = 2 * 1024 * 1024;

export interface DiffRecipeOptions {
  readonly maxTextLength?: number;
}

function appendPart(
  parts: ReconstructionPart[],
  part: ReconstructionPart,
): void {
  const previous = parts.at(-1);

  if (previous?.type === 'literal' && part.type === 'literal') {
    parts[parts.length - 1] = {
      type: 'literal',
      text: previous.text + part.text,
    };
    return;
  }

  if (
    previous?.type === 'source' &&
    part.type === 'source' &&
    previous.parentRevisionId === part.parentRevisionId &&
    previous.end === part.start
  ) {
    parts[parts.length - 1] = {
      type: 'source',
      parentRevisionId: previous.parentRevisionId,
      start: previous.start,
      end: part.end,
    };
    return;
  }

  parts.push(part);
}

function assertCanonicalText(content: string, name: string): void {
  if (content.includes('\r')) {
    throw new Error(`${name} must use canonical LF line endings.`);
  }
}

export function generateEditRecipe(
  parent: ParentSnapshot,
  nextContent: string,
  options: DiffRecipeOptions = {},
): ReconstructionRecipe {
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;

  if (!Number.isSafeInteger(maxTextLength) || maxTextLength < 0) {
    throw new Error('Diff text limit must be a non-negative safe integer.');
  }

  assertCanonicalText(parent.content, 'Parent content');
  assertCanonicalText(nextContent, 'Next content');
  assertValidProvenance(parent.content, parent.provenance);

  if (
    parent.content.length > maxTextLength ||
    nextContent.length > maxTextLength
  ) {
    throw new Error(`Text exceeds the ${maxTextLength} UTF-16 unit diff limit.`);
  }

  const parts: ReconstructionPart[] = [];
  let parentOffset = 0;

  for (const change of diffChars(parent.content, nextContent)) {
    const length = change.value.length;

    if (change.added === true) {
      if (length > 0) {
        appendPart(parts, { type: 'literal', text: change.value });
      }
      continue;
    }

    if (change.removed === true) {
      parentOffset += length;
      continue;
    }

    if (length > 0) {
      appendPart(parts, {
        type: 'source',
        parentRevisionId: parent.revisionId,
        start: parentOffset,
        end: parentOffset + length,
      });
    }
    parentOffset += length;
  }

  if (parentOffset !== parent.content.length) {
    throw new Error('Diff did not consume the complete parent snapshot.');
  }

  const recipe: ReconstructionRecipe = { version: 1, parts };
  validateReconstruction(
    recipe,
    [parent],
    nextContent,
    '__havemind_recipe_validation__',
  );

  return recipe;
}

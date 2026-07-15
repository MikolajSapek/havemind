import { describe, expect, it } from 'vitest';

import { generateEditRecipe } from './diff-recipe.js';
import { classifyFileConflict, mergeSnapshots } from './merge.js';
import { createInitialProvenance } from './provenance.js';
import {
  validateReconstruction,
  type ParentSnapshot,
} from './recipe.js';

function initial(content: string): ParentSnapshot {
  return {
    revisionId: 'base',
    content,
    provenance: createInitialProvenance(content, 'base'),
  };
}

function edit(
  base: ParentSnapshot,
  revisionId: string,
  content: string,
): ParentSnapshot {
  return {
    revisionId,
    ...validateReconstruction(
      generateEditRecipe(base, content),
      [base],
      content,
      revisionId,
    ),
  };
}

describe('mergeSnapshots', () => {
  it('merges non-overlapping edits and preserves both source revisions', () => {
    const base = initial('Alpha middle Omega');
    const left = edit(base, 'left', 'ALPHA middle Omega');
    const right = edit(base, 'right', 'Alpha middle OMEGA');

    const result = mergeSnapshots(base, left, right, 'merge');

    expect(result.kind).toBe('merged');
    if (result.kind !== 'merged') {
      return;
    }
    expect(result.content).toBe('ALPHA middle OMEGA');
    expect(result.provenance).toEqual([
      { length: 1, sourceRevisionId: 'base' },
      { length: 4, sourceRevisionId: 'left' },
      { length: 9, sourceRevisionId: 'base' },
      { length: 4, sourceRevisionId: 'right' },
    ]);
    expect(
      validateReconstruction(result.recipe, [left, right], result.content, 'merge'),
    ).toEqual({ content: result.content, provenance: result.provenance });
  });

  it('reports overlapping replacements as a conflict', () => {
    const base = initial('same line');
    const left = edit(base, 'left', 'LEFT line');
    const right = edit(base, 'right', 'RIGHT line');

    expect(mergeSnapshots(base, left, right, 'merge')).toMatchObject({
      kind: 'conflict',
      reason: 'OVERLAPPING_EDITS',
    });
  });

  it('merges identical concurrent changes exactly once', () => {
    const base = initial('old value');
    const left = edit(base, 'z-left', 'new value');
    const right = edit(base, 'a-right', 'new value');

    const result = mergeSnapshots(base, left, right, 'merge');

    expect(result.kind).toBe('merged');
    if (result.kind !== 'merged') {
      return;
    }
    expect(result.content).toBe('new value');
    expect(result.provenance[0]).toEqual({
      length: 3,
      sourceRevisionId: 'a-right',
    });
  });

  it('treats edit versus delete as a conflict', () => {
    const base = initial('keep this');
    const edited = edit(base, 'left', 'keep this!');
    const deleted = edit(base, 'right', '');

    expect(mergeSnapshots(base, edited, deleted, 'merge')).toMatchObject({
      kind: 'conflict',
      reason: 'OVERLAPPING_EDITS',
    });
  });

  it('merges insertions at different positions', () => {
    const base = initial('AB');
    const left = edit(base, 'left', 'A-left-B');
    const right = edit(base, 'right', 'AB-right-');

    const result = mergeSnapshots(base, left, right, 'merge');
    expect(result).toMatchObject({
      kind: 'merged',
      content: 'A-left-B-right-',
    });
  });

  it('reports different insertions at the same position as a conflict', () => {
    const base = initial('AB');
    const left = edit(base, 'left', 'A-left-B');
    const right = edit(base, 'right', 'A-right-B');

    expect(mergeSnapshots(base, left, right, 'merge')).toMatchObject({
      kind: 'conflict',
      reason: 'OVERLAPPING_EDITS',
    });
  });
});

describe('classifyFileConflict', () => {
  it('requires a decision for edit/delete and divergent rename/rename', () => {
    const base = { content: 'base', path: 'Notes/A.md' };

    expect(
      classifyFileConflict(
        base,
        { content: null, path: 'Notes/A.md' },
        { content: 'edited', path: 'Notes/A.md' },
      ),
    ).toBe('EDIT_DELETE');
    expect(
      classifyFileConflict(
        base,
        { content: 'base', path: 'Notes/Left.md' },
        { content: 'base', path: 'Notes/Right.md' },
      ),
    ).toBe('RENAME_RENAME');
  });

  it('allows rename/edit to continue through content merge', () => {
    expect(
      classifyFileConflict(
        { content: 'base', path: 'Notes/A.md' },
        { content: 'base', path: 'Notes/Renamed.md' },
        { content: 'edited', path: 'Notes/A.md' },
      ),
    ).toBeNull();
  });

  it('allows an uncontested delete and matching concurrent renames', () => {
    const base = { content: 'base', path: 'Notes/A.md' };

    expect(
      classifyFileConflict(
        base,
        { content: null, path: 'Notes/A.md' },
        { content: 'base', path: 'Notes/A.md' },
      ),
    ).toBeNull();
    expect(
      classifyFileConflict(
        base,
        { content: 'base', path: 'Notes/Renamed.md' },
        { content: 'edited', path: 'Notes/Renamed.md' },
      ),
    ).toBeNull();
  });
});

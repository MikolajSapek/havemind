import { describe, expect, it } from 'vitest';

import { createInitialProvenance } from './provenance.js';
import {
  reconstructFromRecipe,
  validateReconstruction,
  type ParentSnapshot,
  type ReconstructionRecipe,
} from './recipe.js';

const parentA: ParentSnapshot = {
  revisionId: 'revision-a',
  content: 'Alpha 😀\nBeta',
  provenance: createInitialProvenance('Alpha 😀\nBeta', 'revision-a'),
};

describe('reconstructFromRecipe', () => {
  it('reconstructs content and provenance from parent ranges and literals', () => {
    const recipe: ReconstructionRecipe = {
      version: 1,
      parts: [
        { type: 'source', parentRevisionId: 'revision-a', start: 0, end: 8 },
        { type: 'literal', text: 'shared\n' },
        { type: 'source', parentRevisionId: 'revision-a', start: 9, end: 13 },
      ],
    };

    expect(
      reconstructFromRecipe(recipe, [parentA], 'revision-current'),
    ).toEqual({
      content: 'Alpha 😀shared\nBeta',
      provenance: [
        { length: 8, sourceRevisionId: 'revision-a' },
        { length: 7, sourceRevisionId: 'revision-current' },
        { length: 4, sourceRevisionId: 'revision-a' },
      ],
    });
  });

  it('rejects a range that splits a surrogate pair', () => {
    const recipe: ReconstructionRecipe = {
      version: 1,
      parts: [
        { type: 'source', parentRevisionId: 'revision-a', start: 0, end: 7 },
      ],
    };

    expect(() =>
      reconstructFromRecipe(recipe, [parentA], 'revision-current'),
    ).toThrow(/UTF-16/i);
  });

  it('rejects unknown parents, CR literals and empty parts', () => {
    expect(() =>
      reconstructFromRecipe(
        {
          version: 1,
          parts: [
            { type: 'source', parentRevisionId: 'missing', start: 0, end: 1 },
          ],
        },
        [parentA],
        'revision-current',
      ),
    ).toThrow(/parent/i);

    expect(() =>
      reconstructFromRecipe(
        { version: 1, parts: [{ type: 'literal', text: 'bad\r\n' }] },
        [parentA],
        'revision-current',
      ),
    ).toThrow(/LF/i);

    expect(
      reconstructFromRecipe(
        { version: 1, parts: [] },
        [parentA],
        'revision-current',
      ),
    ).toEqual({ content: '', provenance: [] });
  });
});

describe('validateReconstruction', () => {
  it('accepts only an exact full-snapshot match', () => {
    const recipe: ReconstructionRecipe = {
      version: 1,
      parts: [
        { type: 'source', parentRevisionId: 'revision-a', start: 0, end: 13 },
        { type: 'literal', text: '!' },
      ],
    };

    expect(
      validateReconstruction(
        recipe,
        [parentA],
        'Alpha 😀\nBeta!',
        'revision-current',
      ),
    ).toEqual({
      content: 'Alpha 😀\nBeta!',
      provenance: [
        { length: 13, sourceRevisionId: 'revision-a' },
        { length: 1, sourceRevisionId: 'revision-current' },
      ],
    });

    expect(() =>
      validateReconstruction(
        recipe,
        [parentA],
        'Alpha 😀\nBeta?',
        'revision-current',
      ),
    ).toThrow(/snapshot/i);
  });
});

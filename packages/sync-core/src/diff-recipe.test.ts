import { describe, expect, it } from 'vitest';

import { generateEditRecipe } from './diff-recipe.js';
import { createInitialProvenance } from './provenance.js';
import { validateReconstruction, type ParentSnapshot } from './recipe.js';

function parent(content: string): ParentSnapshot {
  return {
    revisionId: 'revision-parent',
    content,
    provenance: createInitialProvenance(content, 'revision-parent'),
  };
}

describe('generateEditRecipe', () => {
  it('represents unchanged content as one parent range', () => {
    const base = parent('Alpha 😀\nBeta');

    expect(generateEditRecipe(base, base.content)).toEqual({
      version: 1,
      parts: [
        {
          type: 'source',
          parentRevisionId: 'revision-parent',
          start: 0,
          end: 13,
        },
      ],
    });
  });

  it('round-trips inserts, replacements and deletes with provenance', () => {
    const base = parent('one two two 😀\nlast');
    const next = 'zero one two THREE 😀\nlast!';
    const recipe = generateEditRecipe(base, next);

    expect(
      validateReconstruction(recipe, [base], next, 'revision-current'),
    ).toMatchObject({ content: next });
    expect(generateEditRecipe(base, next)).toEqual(recipe);
  });

  it('does not split emoji surrogate pairs in source ranges', () => {
    const base = parent('A😀B');
    const recipe = generateEditRecipe(base, 'A😀!B');

    expect(recipe).toEqual({
      version: 1,
      parts: [
        {
          type: 'source',
          parentRevisionId: 'revision-parent',
          start: 0,
          end: 3,
        },
        { type: 'literal', text: '!' },
        {
          type: 'source',
          parentRevisionId: 'revision-parent',
          start: 3,
          end: 4,
        },
      ],
    });
  });

  it('supports creating an empty snapshot and replacing all content', () => {
    const base = parent('old');

    expect(generateEditRecipe(base, '')).toEqual({ version: 1, parts: [] });
    expect(generateEditRecipe(base, 'new')).toEqual({
      version: 1,
      parts: [{ type: 'literal', text: 'new' }],
    });
  });

  it('rejects non-canonical or oversized input', () => {
    expect(() => generateEditRecipe(parent('base'), 'bad\r\n')).toThrow(/LF/i);
    expect(() =>
      generateEditRecipe(parent('base'), '12345', { maxTextLength: 4 }),
    ).toThrow(/limit/i);
  });
});

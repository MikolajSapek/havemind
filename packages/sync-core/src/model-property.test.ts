import fc, { type Arbitrary } from 'fast-check';
import { describe, expect, it } from 'vitest';

import { generateEditRecipe } from './diff-recipe.js';
import {
  createInitialProvenance,
  provenanceLength,
} from './provenance.js';
import {
  validateReconstruction,
  type ParentSnapshot,
} from './recipe.js';

const PROPERTY_RUNS = 200;

const unicodeTextArbitrary: Arbitrary<string> = fc
  .string({ maxLength: 48, unit: 'grapheme' })
  .map((value) => value.normalize('NFC').replaceAll('\r', ''));

const unicodeEditHistoryArbitrary = fc.record({
  initial: unicodeTextArbitrary,
  edits: fc.array(unicodeTextArbitrary, { maxLength: 8 }),
});

function initialSnapshot(content: string): ParentSnapshot {
  return {
    revisionId: 'initial',
    content,
    provenance: createInitialProvenance(content),
  };
}

describe('sync-core model properties', () => {
  it('round-trips deterministic recipes for randomized Unicode edits', () => {
    fc.assert(
      fc.property(
        unicodeTextArbitrary,
        unicodeTextArbitrary,
        (before, after) => {
          const parent = initialSnapshot(before);
          const firstRecipe = generateEditRecipe(parent, after);
          const secondRecipe = generateEditRecipe(parent, after);
          const reconstructed = validateReconstruction(
            firstRecipe,
            [parent],
            after,
            'edit',
          );

          expect(firstRecipe).toEqual(secondRecipe);
          expect(reconstructed.content).toBe(after);
          expect(provenanceLength(reconstructed.provenance)).toBe(after.length);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('preserves provenance over randomized sequential Unicode histories', () => {
    fc.assert(
      fc.property(unicodeEditHistoryArbitrary, ({ initial, edits }) => {
        let parent = initialSnapshot(initial);

        edits.forEach((content, index) => {
          const revisionId = `edit-${index}`;
          const recipe = generateEditRecipe(parent, content);
          const reconstructed = validateReconstruction(
            recipe,
            [parent],
            content,
            revisionId,
          );
          expect(provenanceLength(reconstructed.provenance)).toBe(
            content.length,
          );
          parent = { revisionId, ...reconstructed };
        });
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

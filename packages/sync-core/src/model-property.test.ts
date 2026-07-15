import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DurableClientModel } from './client-model.js';
import { generateEditRecipe } from './diff-recipe.js';
import {
  createInitialProvenance,
  provenanceLength,
} from './provenance.js';
import {
  validateReconstruction,
  type ParentSnapshot,
} from './recipe.js';
import { RevisionDag } from './revision-dag.js';
import {
  deliveryScenarioArbitrary,
  unicodeEditHistoryArbitrary,
  unicodeTextArbitrary,
} from './model-generators.js';

const PROPERTY_RUNS = 200;

function initialSnapshot(content: string): ParentSnapshot {
  return {
    revisionId: 'initial',
    content,
    provenance: createInitialProvenance(content),
  };
}

function deliverWithRestarts(
  initial: DurableClientModel,
  delivery: Parameters<DurableClientModel['receiveEvents']>[0],
  restartAfter: readonly boolean[],
): DurableClientModel {
  let client = initial;
  delivery.forEach((event, index) => {
    client.receiveEvents([event]);
    if (restartAfter[index] === true) {
      client = DurableClientModel.restore(client.snapshot());
    }
  });
  return client;
}

function materializeWithRestarts(
  initial: DurableClientModel,
): DurableClientModel {
  let client = initial;
  for (;;) {
    const next = client.nextMaterialization();
    if (next === null) {
      return client;
    }
    client.confirmMaterialized(
      next.serverSequence,
      next.revision.revisionId,
    );
    client = DurableClientModel.restore(client.snapshot());
  }
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

  it('converges two restarted clients under partitions, duplicates and reordering', () => {
    fc.assert(
      fc.property(deliveryScenarioArbitrary, (scenario) => {
        const dag = new RevisionDag();
        expect(dag.addBatch(scenario.nodes)).toEqual(
          scenario.nodes.map(() => 'accepted'),
        );
        expect(dag.addBatch(scenario.deliveryA.map(({ revision }) => revision)))
          .toEqual(scenario.deliveryA.map(() => 'replayed'));

        const clientA = materializeWithRestarts(
          deliverWithRestarts(
            new DurableClientModel(),
            scenario.deliveryA,
            scenario.restartA,
          ),
        );
        const clientB = materializeWithRestarts(
          deliverWithRestarts(
            new DurableClientModel(),
            scenario.deliveryB,
            scenario.restartB,
          ),
        );
        const expectedRevisionIds = scenario.nodes.map(
          ({ revisionId }) => revisionId,
        );

        expect(clientA.downloadedSequence).toBe(scenario.nodes.length);
        expect(clientB.downloadedSequence).toBe(scenario.nodes.length);
        expect(clientA.materializedRevisionIds).toEqual(expectedRevisionIds);
        expect(clientB.materializedRevisionIds).toEqual(expectedRevisionIds);
        expect(clientA.nextPushBatch()).toEqual([]);
        expect(clientB.nextPushBatch()).toEqual([]);
        expect(dag.getHeads('vault-property', 'file-property')).toEqual([
          expectedRevisionIds.at(-1),
        ]);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

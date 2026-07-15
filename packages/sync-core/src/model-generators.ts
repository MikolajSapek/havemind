import fc, { type Arbitrary } from 'fast-check';

import type {
  ServerRevisionEvent,
} from './client-model.js';
import type { RevisionNode } from './revision-dag.js';

export interface UnicodeEditHistory {
  readonly initial: string;
  readonly edits: readonly string[];
}

export interface DeliveryScenario {
  readonly nodes: readonly RevisionNode[];
  readonly deliveryA: readonly ServerRevisionEvent[];
  readonly deliveryB: readonly ServerRevisionEvent[];
  readonly restartA: readonly boolean[];
  readonly restartB: readonly boolean[];
}

export const unicodeTextArbitrary: Arbitrary<string> = fc
  .string({ maxLength: 48, unit: 'grapheme' })
  .map((value) => value.normalize('NFC').replaceAll('\r', ''));

export const unicodeEditHistoryArbitrary: Arbitrary<UnicodeEditHistory> =
  fc.record({
    initial: unicodeTextArbitrary,
    edits: fc.array(unicodeTextArbitrary, { maxLength: 8 }),
  });

function createLinearNodes(count: number): RevisionNode[] {
  return Array.from({ length: count }, (_, index) => ({
    revisionId: `revision-${index + 1}`,
    vaultId: 'vault-property',
    fileId: 'file-property',
    parentRevisionIds: index === 0 ? [] : [`revision-${index}`],
    blobHash: (index + 1).toString(16).padStart(64, '0'),
  }));
}

function randomizedDelivery(
  events: readonly ServerRevisionEvent[],
): Arbitrary<readonly ServerRevisionEvent[]> {
  return fc.subarray([...events]).chain((duplicates) => {
    const candidates = [...events, ...duplicates];
    return fc.shuffledSubarray(candidates, {
      minLength: candidates.length,
      maxLength: candidates.length,
    });
  });
}

function restartFlags(length: number): Arbitrary<readonly boolean[]> {
  return fc.array(fc.boolean(), { minLength: length, maxLength: length });
}

export const deliveryScenarioArbitrary: Arbitrary<DeliveryScenario> = fc
  .integer({ min: 1, max: 24 })
  .chain((count) => {
    const nodes = createLinearNodes(count);
    const events = nodes.map((revision, index) => ({
      serverSequence: index + 1,
      revision,
    }));

    return fc
      .tuple(randomizedDelivery(events), randomizedDelivery(events))
      .chain(([deliveryA, deliveryB]) =>
        fc
          .tuple(restartFlags(deliveryA.length), restartFlags(deliveryB.length))
          .map(([restartA, restartB]) => ({
            nodes,
            deliveryA,
            deliveryB,
            restartA,
            restartB,
          })),
      );
  });

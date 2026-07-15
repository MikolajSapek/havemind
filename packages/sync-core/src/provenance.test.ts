import { describe, expect, it } from 'vitest';

import {
  assertValidProvenance,
  createInitialProvenance,
  normalizeProvenanceRuns,
  sliceProvenance,
  type ProvenanceRun,
} from './provenance.js';

describe('createInitialProvenance', () => {
  it('measures text in UTF-16 code units', () => {
    expect(createInitialProvenance('A😀B')).toEqual([
      { length: 4, sourceRevisionId: 'initial_import' },
    ]);
  });

  it('uses no runs for empty content', () => {
    expect(createInitialProvenance('')).toEqual([]);
  });
});

describe('assertValidProvenance', () => {
  it('accepts runs that exactly cover the document', () => {
    const runs: ProvenanceRun[] = [
      { length: 2, sourceRevisionId: 'revision-a' },
      { length: 3, sourceRevisionId: 'revision-b' },
    ];

    expect(() => assertValidProvenance('abcde', runs)).not.toThrow();
  });

  it.each([
    [[{ length: 0, sourceRevisionId: 'revision-a' }], 'a'],
    [[{ length: 1.5, sourceRevisionId: 'revision-a' }], 'a'],
    [[{ length: 1, sourceRevisionId: '' }], 'a'],
    [[{ length: 1, sourceRevisionId: 'revision-a' }], 'ab'],
    [[{ length: 2, sourceRevisionId: 'revision-a' }], 'a'],
  ])('rejects invalid run coverage %#', (runs, content) => {
    expect(() =>
      assertValidProvenance(content, runs as ProvenanceRun[]),
    ).toThrow();
  });
});

describe('normalizeProvenanceRuns', () => {
  it('coalesces adjacent runs from the same revision', () => {
    expect(
      normalizeProvenanceRuns([
        { length: 2, sourceRevisionId: 'revision-a' },
        { length: 3, sourceRevisionId: 'revision-a' },
        { length: 1, sourceRevisionId: 'revision-b' },
      ]),
    ).toEqual([
      { length: 5, sourceRevisionId: 'revision-a' },
      { length: 1, sourceRevisionId: 'revision-b' },
    ]);
  });
});

describe('sliceProvenance', () => {
  it('slices across run boundaries using half-open UTF-16 offsets', () => {
    const runs: ProvenanceRun[] = [
      { length: 2, sourceRevisionId: 'revision-a' },
      { length: 3, sourceRevisionId: 'revision-b' },
      { length: 2, sourceRevisionId: 'revision-c' },
    ];

    expect(sliceProvenance(runs, 1, 6)).toEqual([
      { length: 1, sourceRevisionId: 'revision-a' },
      { length: 3, sourceRevisionId: 'revision-b' },
      { length: 1, sourceRevisionId: 'revision-c' },
    ]);
  });

  it('rejects reversed and out-of-range slices', () => {
    const runs: ProvenanceRun[] = [
      { length: 3, sourceRevisionId: 'revision-a' },
    ];

    expect(() => sliceProvenance(runs, 2, 1)).toThrow();
    expect(() => sliceProvenance(runs, 0, 4)).toThrow();
  });
});

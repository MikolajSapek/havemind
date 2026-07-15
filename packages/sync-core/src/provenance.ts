export interface ProvenanceRun {
  readonly length: number;
  readonly sourceRevisionId: string;
}

export class ProvenanceValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProvenanceValidationError';
  }
}

function assertRun(run: ProvenanceRun): void {
  if (!Number.isSafeInteger(run.length) || run.length <= 0) {
    throw new ProvenanceValidationError(
      'Provenance run length must be a positive safe integer.',
    );
  }

  if (run.sourceRevisionId.trim().length === 0) {
    throw new ProvenanceValidationError(
      'Provenance source revision ID must not be empty.',
    );
  }
}

export function provenanceLength(runs: readonly ProvenanceRun[]): number {
  return runs.reduce((length, run) => {
    assertRun(run);
    return length + run.length;
  }, 0);
}

export function assertValidProvenance(
  content: string,
  runs: readonly ProvenanceRun[],
): void {
  const coveredLength = provenanceLength(runs);

  if (coveredLength !== content.length) {
    throw new ProvenanceValidationError(
      `Provenance covers ${coveredLength} UTF-16 units, expected ${content.length}.`,
    );
  }
}

export function normalizeProvenanceRuns(
  runs: readonly ProvenanceRun[],
): ProvenanceRun[] {
  const normalized: ProvenanceRun[] = [];

  for (const run of runs) {
    assertRun(run);
    const previous = normalized.at(-1);

    if (previous?.sourceRevisionId === run.sourceRevisionId) {
      normalized[normalized.length - 1] = {
        length: previous.length + run.length,
        sourceRevisionId: previous.sourceRevisionId,
      };
      continue;
    }

    normalized.push({ ...run });
  }

  return normalized;
}

export function createInitialProvenance(
  content: string,
  sourceRevisionId = 'initial_import',
): ProvenanceRun[] {
  if (content.length === 0) {
    return [];
  }

  const runs = [{ length: content.length, sourceRevisionId }];
  assertValidProvenance(content, runs);
  return runs;
}

export function sliceProvenance(
  runs: readonly ProvenanceRun[],
  start: number,
  end: number,
): ProvenanceRun[] {
  const totalLength = provenanceLength(runs);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > totalLength
  ) {
    throw new ProvenanceValidationError(
      `Invalid provenance slice [${start}, ${end}) for length ${totalLength}.`,
    );
  }

  if (start === end) {
    return [];
  }

  const selected: ProvenanceRun[] = [];
  let offset = 0;

  for (const run of runs) {
    const runEnd = offset + run.length;
    const selectedStart = Math.max(start, offset);
    const selectedEnd = Math.min(end, runEnd);

    if (selectedStart < selectedEnd) {
      selected.push({
        length: selectedEnd - selectedStart,
        sourceRevisionId: run.sourceRevisionId,
      });
    }

    offset = runEnd;
    if (offset >= end) {
      break;
    }
  }

  return normalizeProvenanceRuns(selected);
}

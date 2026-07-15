import {
  assertValidProvenance,
  normalizeProvenanceRuns,
  sliceProvenance,
  type ProvenanceRun,
} from './provenance.js';

export interface ParentSnapshot {
  readonly revisionId: string;
  readonly content: string;
  readonly provenance: readonly ProvenanceRun[];
}

export type ReconstructionPart =
  | {
      readonly type: 'source';
      readonly parentRevisionId: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly type: 'literal';
      readonly text: string;
    };

export interface ReconstructionRecipe {
  readonly version: 1;
  readonly parts: readonly ReconstructionPart[];
}

export interface ReconstructedSnapshot {
  readonly content: string;
  readonly provenance: readonly ProvenanceRun[];
}

export class ReconstructionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReconstructionError';
  }
}

function isUtf16Boundary(content: string, offset: number): boolean {
  if (offset <= 0 || offset >= content.length) {
    return true;
  }

  const previous = content.charCodeAt(offset - 1);
  const current = content.charCodeAt(offset);
  const previousIsHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;
  const currentIsLowSurrogate = current >= 0xdc00 && current <= 0xdfff;

  return !(previousIsHighSurrogate && currentIsLowSurrogate);
}

function indexParents(
  parents: readonly ParentSnapshot[],
): ReadonlyMap<string, ParentSnapshot> {
  const byId = new Map<string, ParentSnapshot>();

  for (const parent of parents) {
    if (parent.revisionId.trim().length === 0) {
      throw new ReconstructionError('Parent revision ID must not be empty.');
    }

    if (byId.has(parent.revisionId)) {
      throw new ReconstructionError(
        `Duplicate parent revision: ${parent.revisionId}.`,
      );
    }

    if (parent.content.includes('\r')) {
      throw new ReconstructionError('Parent content must use canonical LF.');
    }

    assertValidProvenance(parent.content, parent.provenance);
    byId.set(parent.revisionId, parent);
  }

  return byId;
}

export function reconstructFromRecipe(
  recipe: ReconstructionRecipe,
  parents: readonly ParentSnapshot[],
  currentRevisionId: string,
): ReconstructedSnapshot {
  if (recipe.version !== 1) {
    throw new ReconstructionError('Unsupported reconstruction recipe version.');
  }

  if (currentRevisionId.trim().length === 0) {
    throw new ReconstructionError('Current revision ID must not be empty.');
  }

  const parentsById = indexParents(parents);
  const contentParts: string[] = [];
  const provenanceParts: ProvenanceRun[] = [];

  for (const part of recipe.parts) {
    if (part.type === 'literal') {
      if (part.text.length === 0) {
        throw new ReconstructionError('Literal recipe parts must not be empty.');
      }

      if (part.text.includes('\r')) {
        throw new ReconstructionError('Literal recipe text must use canonical LF.');
      }

      contentParts.push(part.text);
      provenanceParts.push({
        length: part.text.length,
        sourceRevisionId: currentRevisionId,
      });
      continue;
    }

    const parent = parentsById.get(part.parentRevisionId);
    if (parent === undefined) {
      throw new ReconstructionError(
        `Unknown parent revision: ${part.parentRevisionId}.`,
      );
    }

    if (
      !Number.isSafeInteger(part.start) ||
      !Number.isSafeInteger(part.end) ||
      part.start < 0 ||
      part.end <= part.start ||
      part.end > parent.content.length
    ) {
      throw new ReconstructionError('Invalid source range in reconstruction recipe.');
    }

    if (
      !isUtf16Boundary(parent.content, part.start) ||
      !isUtf16Boundary(parent.content, part.end)
    ) {
      throw new ReconstructionError(
        'Source range must end on valid UTF-16 boundaries.',
      );
    }

    contentParts.push(parent.content.slice(part.start, part.end));
    provenanceParts.push(
      ...sliceProvenance(parent.provenance, part.start, part.end),
    );
  }

  const content = contentParts.join('');
  const provenance = normalizeProvenanceRuns(provenanceParts);
  assertValidProvenance(content, provenance);

  return { content, provenance };
}

export function validateReconstruction(
  recipe: ReconstructionRecipe,
  parents: readonly ParentSnapshot[],
  expectedContent: string,
  currentRevisionId: string,
): ReconstructedSnapshot {
  if (expectedContent.includes('\r')) {
    throw new ReconstructionError('Expected snapshot must use canonical LF.');
  }

  const reconstructed = reconstructFromRecipe(
    recipe,
    parents,
    currentRevisionId,
  );

  if (reconstructed.content !== expectedContent) {
    throw new ReconstructionError(
      'Reconstruction recipe does not match the full snapshot.',
    );
  }

  return reconstructed;
}

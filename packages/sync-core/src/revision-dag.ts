export interface RevisionNode {
  readonly revisionId: string;
  readonly vaultId: string;
  readonly fileId: string;
  readonly parentRevisionIds: readonly string[];
  readonly blobHash: string;
}

export type RevisionAcceptance = 'accepted' | 'replayed';

export type RevisionDagErrorCode =
  | 'BATCH_NOT_TOPOLOGICAL'
  | 'DUPLICATE_PARENT'
  | 'FILE_ALREADY_EXISTS'
  | 'HEAD_SET_CHANGED'
  | 'INVALID_REVISION'
  | 'PARENT_FILE_MISMATCH'
  | 'PARENT_NOT_FOUND'
  | 'REVISION_ID_REUSE'
  | 'SELF_PARENT'
  | 'UNSORTED_PARENTS';

export class RevisionDagError extends Error {
  public constructor(
    public readonly code: RevisionDagErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RevisionDagError';
  }
}

function fileKey(vaultId: string, fileId: string): string {
  return `${vaultId}\u0000${fileId}`;
}

function compareIds(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameRevision(left: RevisionNode, right: RevisionNode): boolean {
  return (
    left.revisionId === right.revisionId &&
    left.vaultId === right.vaultId &&
    left.fileId === right.fileId &&
    left.blobHash === right.blobHash &&
    sameStringArray(left.parentRevisionIds, right.parentRevisionIds)
  );
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new RevisionDagError(
      'INVALID_REVISION',
      `${field} must not be empty.`,
    );
  }
}

function assertParentList(node: RevisionNode): void {
  const seen = new Set<string>();

  for (const parentId of node.parentRevisionIds) {
    assertNonEmpty(parentId, 'Parent revision ID');

    if (parentId === node.revisionId) {
      throw new RevisionDagError(
        'SELF_PARENT',
        'A revision cannot reference itself as a parent.',
      );
    }

    if (seen.has(parentId)) {
      throw new RevisionDagError(
        'DUPLICATE_PARENT',
        `Duplicate parent revision: ${parentId}.`,
      );
    }
    seen.add(parentId);
  }

  for (let index = 1; index < node.parentRevisionIds.length; index += 1) {
    const previous = node.parentRevisionIds[index - 1];
    const current = node.parentRevisionIds[index];
    if (previous !== undefined && current !== undefined && previous > current) {
      throw new RevisionDagError(
        'UNSORTED_PARENTS',
        'Parent revision IDs must use canonical ascending order.',
      );
    }
  }
}

function sameSet(
  values: ReadonlySet<string>,
  expected: readonly string[],
): boolean {
  return (
    values.size === expected.length && expected.every((value) => values.has(value))
  );
}

export class RevisionDag {
  private revisions = new Map<string, RevisionNode>();
  private headsByFile = new Map<string, Set<string>>();

  public get size(): number {
    return this.revisions.size;
  }

  public add(node: RevisionNode): RevisionAcceptance {
    const existing = this.revisions.get(node.revisionId);
    if (existing !== undefined) {
      if (sameRevision(existing, node)) {
        return 'replayed';
      }

      throw new RevisionDagError(
        'REVISION_ID_REUSE',
        `Revision ID ${node.revisionId} was reused with different bytes.`,
      );
    }

    assertNonEmpty(node.revisionId, 'Revision ID');
    assertNonEmpty(node.vaultId, 'Vault ID');
    assertNonEmpty(node.fileId, 'File ID');
    assertNonEmpty(node.blobHash, 'Blob hash');
    assertParentList(node);

    const key = fileKey(node.vaultId, node.fileId);
    const currentHeads = this.headsByFile.get(key) ?? new Set<string>();

    if (node.parentRevisionIds.length === 0) {
      if (currentHeads.size > 0) {
        throw new RevisionDagError(
          'FILE_ALREADY_EXISTS',
          'Only the first revision of a file may have no parents.',
        );
      }
    } else {
      for (const parentId of node.parentRevisionIds) {
        const parent = this.revisions.get(parentId);
        if (parent === undefined) {
          throw new RevisionDagError(
            'PARENT_NOT_FOUND',
            `Parent revision ${parentId} does not exist.`,
          );
        }

        if (parent.vaultId !== node.vaultId || parent.fileId !== node.fileId) {
          throw new RevisionDagError(
            'PARENT_FILE_MISMATCH',
            `Parent revision ${parentId} belongs to another vault or file.`,
          );
        }
      }

      if (
        node.parentRevisionIds.length >= 2 &&
        !sameSet(currentHeads, node.parentRevisionIds)
      ) {
        throw new RevisionDagError(
          'HEAD_SET_CHANGED',
          'Reconciliation parents no longer match the current head set.',
        );
      }
    }

    const nextHeads = new Set(currentHeads);
    for (const parentId of node.parentRevisionIds) {
      nextHeads.delete(parentId);
    }
    nextHeads.add(node.revisionId);

    this.revisions.set(node.revisionId, {
      ...node,
      parentRevisionIds: [...node.parentRevisionIds],
    });
    this.headsByFile.set(key, nextHeads);

    return 'accepted';
  }

  public addBatch(nodes: readonly RevisionNode[]): RevisionAcceptance[] {
    const positionById = new Map<string, number>();
    nodes.forEach((node, index) => {
      if (!positionById.has(node.revisionId)) {
        positionById.set(node.revisionId, index);
      }
    });

    nodes.forEach((node, index) => {
      for (const parentId of node.parentRevisionIds) {
        const parentPosition = positionById.get(parentId);
        if (
          !this.revisions.has(parentId) &&
          parentPosition !== undefined &&
          parentPosition >= index
        ) {
          throw new RevisionDagError(
            'BATCH_NOT_TOPOLOGICAL',
            `Parent ${parentId} must appear before ${node.revisionId}.`,
          );
        }
      }
    });

    const working = this.clone();
    const results = nodes.map((node) => working.add(node));
    this.revisions = working.revisions;
    this.headsByFile = working.headsByFile;
    return results;
  }

  public getHeads(vaultId: string, fileId: string): string[] {
    return [...(this.headsByFile.get(fileKey(vaultId, fileId)) ?? [])].sort(
      compareIds,
    );
  }

  private clone(): RevisionDag {
    const copy = new RevisionDag();
    copy.revisions = new Map(
      [...this.revisions].map(([revisionId, node]) => [
        revisionId,
        { ...node, parentRevisionIds: [...node.parentRevisionIds] },
      ]),
    );
    copy.headsByFile = new Map(
      [...this.headsByFile].map(([key, heads]) => [key, new Set(heads)]),
    );
    return copy;
  }
}

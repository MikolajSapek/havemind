import {
  canonicalizeVaultPath,
  pathCollisionKey,
} from '@havemind/protocol';

export interface PathClaim {
  readonly fileId: string;
  readonly revisionId: string;
  readonly path: string;
  readonly serverSequence: number;
}

export interface PathConflict {
  readonly collisionKey: string;
  readonly contenders: readonly PathClaim[];
  readonly winner: PathClaim;
}

export interface PathOwnershipResult {
  readonly conflicts: readonly PathConflict[];
  readonly winners: readonly PathClaim[];
}

function compareClaims(left: PathClaim, right: PathClaim): number {
  if (left.serverSequence !== right.serverSequence) {
    return left.serverSequence - right.serverSequence;
  }
  if (left.revisionId !== right.revisionId) {
    return left.revisionId < right.revisionId ? -1 : 1;
  }
  if (left.fileId !== right.fileId) {
    return left.fileId < right.fileId ? -1 : 1;
  }
  return left.path < right.path ? -1 : left.path === right.path ? 0 : 1;
}

function validateClaim(claim: PathClaim): PathClaim {
  if (claim.fileId.trim().length === 0 || claim.revisionId.trim().length === 0) {
    throw new Error('Path claim file and revision IDs must not be empty.');
  }
  if (!Number.isSafeInteger(claim.serverSequence) || claim.serverSequence <= 0) {
    throw new Error('Path claim server sequence must be a positive safe integer.');
  }

  return { ...claim, path: canonicalizeVaultPath(claim.path) };
}

export function resolvePathOwnership(
  claims: readonly PathClaim[],
): PathOwnershipResult {
  const groups = new Map<string, PathClaim[]>();

  for (const input of claims) {
    const claim = validateClaim(input);
    const key = pathCollisionKey(claim.path);
    const group = groups.get(key) ?? [];
    group.push(claim);
    groups.set(key, group);
  }

  const winners: PathClaim[] = [];
  const conflicts: PathConflict[] = [];

  for (const [collisionKey, group] of [...groups].sort(([left], [right]) =>
    left < right ? -1 : left === right ? 0 : 1,
  )) {
    const bestByFile = new Map<string, PathClaim>();
    for (const candidate of group.sort(compareClaims)) {
      if (!bestByFile.has(candidate.fileId)) {
        bestByFile.set(candidate.fileId, candidate);
      }
    }

    const contenders = [...bestByFile.values()].sort(compareClaims);
    const winner = contenders[0];
    if (winner === undefined) {
      continue;
    }

    winners.push(winner);
    if (contenders.length > 1) {
      conflicts.push({ collisionKey, contenders, winner });
    }
  }

  return { conflicts, winners };
}

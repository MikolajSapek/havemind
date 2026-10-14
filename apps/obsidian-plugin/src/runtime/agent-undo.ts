/**
 * Undo what an AI agent did (plans 014, 016): for every note it changed, put
 * back the last version someone else wrote, as a normal edit, or remove the
 * note when the agent created it. A note a person changed after the agent is
 * left alone: undoing it would throw their work away.
 */

import type { RemoteEvent } from '../sync/sync-runner';

export type UndoStep =
  | { readonly fileId: string; readonly action: 'restore'; readonly revisionId: string }
  | { readonly fileId: string; readonly action: 'remove' };

/** One note's undo, from its events; null when there is nothing to undo. */
export function planAgentUndo(fileId: string, events: readonly RemoteEvent[], agentId: string): UndoStep | null {
  const ordered = [...events].sort((a, b) => a.serverSequence - b.serverSequence);
  const head = ordered[ordered.length - 1];
  if (head === undefined || head.revision.authorMembershipId !== agentId) return null;
  const before = [...ordered].reverse().find((event) => event.revision.authorMembershipId !== agentId);
  return before === undefined
    ? { fileId, action: 'remove' }
    : { fileId, action: 'restore', revisionId: before.revision.revisionId };
}

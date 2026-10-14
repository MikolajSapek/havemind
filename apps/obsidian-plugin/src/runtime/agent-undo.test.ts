import { describe, expect, it } from 'vitest';

import type { RemoteEvent } from '../sync/sync-runner';
import { planAgentUndo } from './agent-undo';

const ev = (seq: number, author: string): RemoteEvent => ({
  serverSequence: seq,
  revision: { revisionId: `r${seq}`, fileId: 'f', contentHash: 'h', authorMembershipId: author },
});

describe('undoing an agent (plan 016)', () => {
  it('puts back the last version someone else wrote', () => {
    expect(planAgentUndo('f', [ev(1, 'magda'), ev(3, 'bot'), ev(2, 'bot')], 'bot')).toEqual({
      fileId: 'f', action: 'restore', revisionId: 'r1',
    });
  });

  it('removes a note the agent created', () => {
    expect(planAgentUndo('f', [ev(4, 'bot')], 'bot')).toEqual({ fileId: 'f', action: 'remove' });
  });

  it('leaves a note a person changed after the agent', () => {
    expect(planAgentUndo('f', [ev(1, 'bot'), ev(2, 'magda')], 'bot')).toBeNull();
    expect(planAgentUndo('f', [], 'bot')).toBeNull();
  });
});

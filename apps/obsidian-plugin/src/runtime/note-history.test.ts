import { describe, expect, it } from 'vitest';

import type { RemoteEvent } from '../sync/sync-runner';
import { buildNoteHistory } from './note-history';
import type { RosterMember } from './roster';

const roster: RosterMember[] = [
  { membershipId: 'm1', displayName: 'You', role: 'owner', self: true },
  { membershipId: 'm2', displayName: 'Hubert', role: 'editor', self: false },
];

const ev = (id: string, sequence: number, author?: string, acceptedAt?: string): RemoteEvent => ({
  serverSequence: sequence,
  revision: {
    revisionId: id,
    fileId: 'f1',
    contentHash: `h-${id}`,
    ...(author === undefined ? {} : { authorMembershipId: author }),
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
  },
});

const NOW = Date.parse('2026-10-14T18:00:00');

describe('buildNoteHistory', () => {
  it('lists accepted versions newest first, with who and when', () => {
    const rows = buildNoteHistory(
      [ev('a', 1, 'm2', '2026-10-13T09:30:00'), ev('b', 4, 'm1', '2026-10-14T16:05:00')],
      roster,
      NOW,
    );
    expect(rows.map((r) => [r.revisionId, r.author, r.when])).toEqual([
      ['b', 'You', 'Today 16:05'],
      ['a', 'Hubert', 'Yesterday 09:30'],
    ]);
  });

  it('leaves out versions still waiting to be sent', () => {
    expect(buildNoteHistory([ev('q', 0, 'm1')], roster, NOW)).toEqual([]);
  });

  it('never guesses: an unknown author or a missing time says so', () => {
    const [row] = buildNoteHistory([ev('x', 2, 'm9')], roster, NOW);
    expect(row?.author).toBe('Unknown author');
    expect(row?.when).toBe('Time not recorded');
  });
});

import { describe, expect, it } from 'vitest';

import type { RemoteEvent } from '../sync/sync-runner';
import { lastEditedLabel, newestAuthor } from './last-edited';
import type { RosterMember } from './roster';

function head(sequence: number, author?: string): RemoteEvent {
  return {
    serverSequence: sequence,
    revision: {
      revisionId: `r${sequence}`,
      fileId: 'f',
      contentHash: `h${sequence}`,
      ...(author === undefined ? {} : { authorMembershipId: author }),
    },
  };
}

const roster: RosterMember[] = [
  { membershipId: 'm-me', displayName: 'You', role: 'owner', self: true },
  { membershipId: 'm-magda', displayName: 'Magda', role: 'editor', self: false },
];

describe('last edited label', () => {
  it('names the author of the newest head', () => {
    expect(newestAuthor([head(3, 'm-me'), head(7, 'm-magda')])).toBe('m-magda');
    expect(lastEditedLabel('m-magda', roster)).toBe('Last edited by Magda');
  });

  it('says "you" for this device and stays neutral for an unknown member', () => {
    expect(lastEditedLabel('m-me', roster)).toBe('Last edited by you');
    expect(lastEditedLabel('m-gone', roster)).toBe('Last edited by another member');
  });

  it('shows nothing without a known author', () => {
    expect(newestAuthor([])).toBeNull();
    expect(newestAuthor([head(2)])).toBeNull();
    expect(lastEditedLabel(null, roster)).toBe('');
  });
});

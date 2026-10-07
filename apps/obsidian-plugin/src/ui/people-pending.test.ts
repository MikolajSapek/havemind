import { describe, expect, it, vi } from 'vitest';

import { buildConnectionPanel } from '../runtime/status';
import { buildRejoinRosterView } from '../runtime/rejoin-roster';
import { flatten, syncedPane } from '../test/dom';
import type { MockElement } from '../test/obsidian.mock';

function openPeople(root: MockElement): void {
  flatten(root).find((el) => el.attrs.role === 'tab' && el.attrs['aria-label'] === 'People')?.triggerClick();
}

describe('People shows a waiting device without opening the invite form', () => {
  it('draws one card per unexpired request, and its button opens the approval', () => {
    const onOpenComposer = vi.fn();
    const root = syncedPane({
      panelProvider: () => buildConnectionPanel({ status: 'synced' }),
      rejoinRosterProvider: () =>
        buildRejoinRosterView([{ membershipId: 'm1', displayName: 'You', role: 'owner', self: true }]),
      pendingApprovalsProvider: () => [
        { invitationId: 'i1', expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(), intendedMemberDisplayName: 'Magda', intendedRole: 'editor' },
        { invitationId: 'i2', expiresAt: new Date(Date.now() - 60_000).toISOString(), intendedMemberDisplayName: 'Old' },
      ],
      onOpenComposer,
    });
    openPeople(root);
    const texts = flatten(root).map((el) => el.text);
    expect(texts).toContain('Magda wants to join');
    expect(texts.some((t) => /^As editor · expires in 1[12] min$/.test(t))).toBe(true);
    expect(texts).not.toContain('Old wants to join');
    flatten(root).find((el) => el.tag === 'button' && el.text === 'Enter Magda’s code')?.triggerClick();
    expect(onOpenComposer).toHaveBeenCalledOnce();
  });
});

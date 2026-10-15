import { describe, expect, it, vi } from 'vitest';

import { buildConnectionPanel } from '../runtime/status';
import { buildRejoinRosterView } from '../runtime/rejoin-roster';
import { flatten, syncedPane } from '../test/dom';
import type { MockElement } from '../test/obsidian.mock';

function openPeople(root: MockElement): void {
  flatten(root).find((el) => el.attrs.role === 'tab' && el.attrs['aria-label'] === 'People')?.triggerClick();
}

describe('People shows a waiting device without opening the invite form', () => {
  it('draws one card per unexpired request, with no detour through the invite form', () => {
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
    expect(flatten(root).some((el) => el.text === 'Enter Magda’s code')).toBe(false);
    expect(onOpenComposer).not.toHaveBeenCalled();
  });

  it('takes the code inside the card: Enter and Approve both approve', () => {
    const onApprove = vi.fn();
    const root = syncedPane({
      panelProvider: () => buildConnectionPanel({ status: 'synced' }),
      rejoinRosterProvider: () =>
        buildRejoinRosterView([{ membershipId: 'm1', displayName: 'You', role: 'owner', self: true }]),
      pendingApprovalsProvider: () => [
        { invitationId: 'i1', expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(), intendedMemberDisplayName: 'Magda' },
      ],
      onOpenComposer: vi.fn(),
      onApprove,
      onReject: vi.fn(),
    });
    openPeople(root);
    const field = flatten(root).find((el) => el.attrs.id === 'havemind-approve-i1');
    expect(field).toBeDefined();
    if (field === undefined) return;
    field.value = '123456';
    field.triggerEvent('keydown', { key: 'Enter' });
    expect(onApprove).toHaveBeenCalledWith('i1', '123456', expect.any(Function));
    onApprove.mockClear();
    flatten(root).find((el) => el.tag === 'button' && el.text === 'Approve')?.triggerClick();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(flatten(root).some((el) => el.tag === 'button' && el.text === 'Reject')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import { ItemView, WorkspaceLeaf, type MockElement } from '../../test/obsidian.mock';

import { renderPendingRow } from './pending-approval-row';

function content(): MockElement {
  return new ItemView(new WorkspaceLeaf()).containerEl.children[1] as unknown as MockElement;
}

function all(element: MockElement): MockElement[] {
  return element.children.flatMap((child) => [child, ...all(child)]);
}

const entry = { invitationId: 'inv-1', expiresAt: '2026-09-29T20:00:00.000Z' };

describe('renderPendingRow Reject', () => {
  it('rejects the waiting device only after a second, confirming click', () => {
    const root = content();
    const rejected: string[] = [];
    renderPendingRow(root as unknown as HTMLElement, entry, {
      onReject: (invitationId) => rejected.push(invitationId),
    });
    const button = all(root).find(({ text }) => text === 'Reject');
    button?.triggerClick();
    expect(rejected).toEqual([]);
    expect(button?.text).toBe('Confirm reject');
    button?.triggerClick();
    expect(rejected).toEqual(['inv-1']);
  });

  it('offers no Reject button when the owner cannot reject', () => {
    const root = content();
    renderPendingRow(root as unknown as HTMLElement, entry, {});
    expect(all(root).some(({ text }) => text === 'Reject')).toBe(false);
  });
});

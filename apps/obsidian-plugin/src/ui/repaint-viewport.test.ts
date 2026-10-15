import { describe, expect, it } from 'vitest';

import { buildConnectionPanel } from '../runtime/status';
import { buildRejoinRosterView } from '../runtime/rejoin-roster';
import { flatten } from '../test/dom';
import { WorkspaceLeaf, type MockElement } from '../test/obsidian.mock';

import { HavemindOnboardingView } from './onboarding-view';

function pane(): { view: HavemindOnboardingView; root: MockElement } {
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
    panelProvider: () => buildConnectionPanel({ status: 'synced' }),
    rejoinRosterProvider: () =>
      buildRejoinRosterView([{ membershipId: 'm1', displayName: 'You', role: 'owner', self: true }]),
    pendingApprovalsProvider: () => [
      { invitationId: 'i1', expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(), intendedMemberDisplayName: 'Magda' },
    ],
    onApprove: () => undefined,
  });
  void view.onOpen();
  return { view, root: view.containerEl as unknown as MockElement };
}

const tab = (root: MockElement, label: string): MockElement | undefined =>
  flatten(root).find((el) => el.attrs.role === 'tab' && (el.attrs['aria-label'] ?? '').startsWith(label));
const field = (root: MockElement): MockElement | undefined =>
  flatten(root).find((el) => el.attrs.id === ['havemind', 'approve', 'i1'].join('-'));
const tabBody = (root: MockElement): MockElement | undefined =>
  flatten(root).find((el) => el.classes.includes('havemind-tab-body'));

describe('a repaint keeps what the user is doing', () => {
  it('puts focus and the caret back in the field that had them', () => {
    const { view, root } = pane();
    tab(root, 'People')?.triggerClick();
    const before = field(root);
    before?.focus();
    before?.setSelectionRange(2, 4);

    view.refreshNow();

    const after = field(root);
    expect(after).not.toBe(before);
    expect(after?.focused).toBe(true);
    expect([after?.selectionStart, after?.selectionEnd]).toEqual([2, 4]);
  });

  it('keeps the scroll position of the open tab', () => {
    const { view, root } = pane();
    tab(root, 'People')?.triggerClick();
    const body = tabBody(root);
    if (body !== undefined) body.scrollTop = 120;

    view.refreshNow();

    expect(tabBody(root)?.scrollTop).toBe(120);
  });

  it('starts another tab at the top', () => {
    const { root } = pane();
    tab(root, 'People')?.triggerClick();
    const body = tabBody(root);
    if (body !== undefined) body.scrollTop = 120;

    tab(root, 'Activity')?.triggerClick();

    expect(tabBody(root)?.scrollTop).toBe(0);
  });

  it('leaves focus alone when nothing inside the pane had it', () => {
    const { view, root } = pane();
    tab(root, 'People')?.triggerClick();
    view.refreshNow();
    expect(field(root)?.focused).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { buildRejoinRosterView } from '../runtime/rejoin-roster';
import { flatten, syncedPane } from '../test/dom';
import type { MockElement } from '../test/obsidian.mock';

function openPeople(root: MockElement): void {
  flatten(root).find((el) => el.attrs.role === 'tab' && el.attrs['aria-label'] === 'People')?.triggerClick();
}

function buttons(root: MockElement): string[] {
  return flatten(root).filter((el) => el.tag === 'button').map((el) => el.text);
}

function peopleFor(role: 'owner' | 'editor'): MockElement {
  const root = syncedPane({
    rejoinRosterProvider: () =>
      buildRejoinRosterView([{ membershipId: 'm1', displayName: 'You', role, self: true }]),
    onOpenComposer: vi.fn(),
    onAddAgent: vi.fn(),
    onOpenAddAgent: vi.fn(),
  });
  openPeople(root);
  return root;
}

describe('People offers Invite and Add agent only to the owner', () => {
  it('shows both to the owner', () => {
    expect(buttons(peopleFor('owner'))).toEqual(expect.arrayContaining(['Invite someone', 'Add agent']));
  });

  it('shows neither to an editor', () => {
    const labels = buttons(peopleFor('editor'));
    expect(labels).not.toContain('Invite someone');
    expect(labels).not.toContain('Add agent');
  });

  it('shows neither while the roster is not known yet', () => {
    const root = syncedPane({ onOpenComposer: vi.fn(), onAddAgent: vi.fn(), onOpenAddAgent: vi.fn() });
    openPeople(root);
    expect(buttons(root)).not.toContain('Invite someone');
  });
});

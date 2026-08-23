import { describe, expect, it } from 'vitest';

import { buildPaneTabs, type PaneTabsInput } from './pane-tabs';

const base: PaneTabsInput = {
  active: 'status',
  activityCount: 0,
  peopleCount: 0,
  attentionCount: 0,
  canInvite: false,
};

describe('pane tabs', () => {
  it('offers three tabs to a member and a fourth to an owner', () => {
    expect(buildPaneTabs(base).tabs.map((t) => t.id)).toEqual([
      'status',
      'activity',
      'people',
    ]);
    expect(
      buildPaneTabs({ ...base, canInvite: true }).tabs.map((t) => t.id),
    ).toContain('invite');
  });

  it('keeps every label short enough for a narrow strip', () => {
    // A truncated tab label ("Confl…") is what made the designer reject tabs.
    for (const tab of buildPaneTabs({ ...base, canInvite: true }).tabs) {
      expect(tab.label.length).toBeLessThanOrEqual(8);
    }
  });

  it('shows a count only when there is something to count', () => {
    const quiet = buildPaneTabs(base);
    expect(quiet.tabs.every((t) => t.count === undefined)).toBe(true);

    const busy = buildPaneTabs({ ...base, activityCount: 12, peopleCount: 2 });
    expect(busy.tabs.find((t) => t.id === 'activity')?.count).toBe(12);
    expect(busy.tabs.find((t) => t.id === 'people')?.count).toBe(2);
  });

  it('marks the status tab when something needs the user', () => {
    const view = buildPaneTabs({ ...base, attentionCount: 2 });
    const status = view.tabs.find((t) => t.id === 'status');
    expect(status?.needsAttention).toBe(true);
    expect(status?.count).toBe(2);
  });

  it('never marks a tab that has nothing wrong', () => {
    const view = buildPaneTabs({ ...base, activityCount: 40 });
    expect(view.tabs.every((t) => t.needsAttention !== true)).toBe(true);
  });

  it('falls back to status when the active tab no longer exists', () => {
    // An owner who loses invite rights while sitting on that tab would
    // otherwise be left looking at an empty body.
    const view = buildPaneTabs({ ...base, active: 'invite', canInvite: false });
    expect(view.active).toBe('status');
  });

  it('keeps the active tab when it is still offered', () => {
    const view = buildPaneTabs({ ...base, active: 'people' });
    expect(view.active).toBe('people');
  });
});

import { describe, expect, it } from 'vitest';

import { buildPaneTabs, type PaneTabsInput } from './pane-tabs';

const base: PaneTabsInput = {
  active: 'status',
  attentionCount: 0,
};

describe('pane tabs', () => {
  it('offers the same three tabs to everyone', () => {
    // Inviting was a fourth, owner-only tab. A strip that changes shape by role
    // makes the pane two different products to describe and support, so it
    // became a modal launched from People instead.
    expect(buildPaneTabs(base).tabs.map((t) => t.id)).toEqual([
      'status',
      'activity',
      'people',
    ]);
  });

  it('keeps every label short enough for a narrow strip', () => {
    // A truncated tab label ("Confl…") is what made the designer reject tabs.
    for (const tab of buildPaneTabs(base).tabs) {
      expect(tab.label.length).toBeLessThanOrEqual(8);
    }
  });

  it('uses the Round 2 icon vocabulary', () => {
    // The design deliberately separates current connection state (check),
    // change activity (pulse), and members (users). Reusing history/activity
    // glyphs made Status and Activity read as two kinds of activity.
    expect(buildPaneTabs(base).tabs.map((tab) => tab.icon)).toEqual([
      'circle-check',
      'activity',
      'users',
    ]);
  });

  it('carries a count only on the tab that needs action', () => {
    // Activity and People used to show one too. Three numbers competing in a
    // 300px strip made the one that matters unreadable, and "12 today" is not
    // something anyone can act on.
    const busy = buildPaneTabs({ ...base, attentionCount: 2 });
    expect(busy.tabs.find((t) => t.id === 'status')?.count).toBe(2);
    expect(busy.tabs.find((t) => t.id === 'activity')?.count).toBeUndefined();
    expect(busy.tabs.find((t) => t.id === 'people')?.count).toBeUndefined();
  });

  it('marks the status tab when something needs the user', () => {
    const view = buildPaneTabs({ ...base, attentionCount: 2 });
    const status = view.tabs.find((t) => t.id === 'status');
    expect(status?.needsAttention).toBe(true);
    expect(status?.count).toBe(2);
  });

  it('never marks a tab that has nothing wrong', () => {
    const view = buildPaneTabs(base);
    expect(view.tabs.every((t) => t.needsAttention !== true)).toBe(true);
  });

  it('falls back to status when the active tab no longer exists', () => {
    // Defensive: a persisted selection from an older build could name a tab
    // this version does not offer, and an unrecognised id must not leave the
    // body blank.
    const view = buildPaneTabs({
      ...base,
      active: 'invite' as unknown as PaneTabsInput['active'],
    });
    expect(view.active).toBe('status');
  });

  it('keeps the active tab when it is still offered', () => {
    const view = buildPaneTabs({ ...base, active: 'people' });
    expect(view.active).toBe('people');
  });
});

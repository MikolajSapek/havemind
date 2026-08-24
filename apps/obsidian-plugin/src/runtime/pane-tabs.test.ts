import { describe, expect, it } from 'vitest';

import { buildPaneTabs, type PaneTabsInput } from './pane-tabs';

const base: PaneTabsInput = {
  active: 'status',
  attentionCount: 0,
};

describe('pane tabs', () => {
  it('offers the same four tabs to everyone', () => {
    // Connection management must remain visible in the pane: hiding the server
    // and recovery actions behind an overflow menu makes a connected vault
    // look like it has no way to change or repair its connection.
    expect(buildPaneTabs(base).tabs.map((t) => t.id)).toEqual([
      'status',
      'activity',
      'people',
      'connect',
    ]);
  });

  it('keeps every label short enough for a narrow strip', () => {
    // A truncated tab label ("Confl…") is what made the designer reject tabs.
    for (const tab of buildPaneTabs(base).tabs) {
      expect(tab.label.length).toBeLessThanOrEqual(8);
    }
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

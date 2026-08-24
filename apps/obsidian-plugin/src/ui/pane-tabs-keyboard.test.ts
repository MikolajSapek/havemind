/**
 * The tab strip has to work without a mouse.
 *
 * The strip was built as a proper `role="tablist"` — roving tabindex, one tab
 * stop, `aria-selected` on the open tab — and its own comment said "arrow keys
 * move within the strip". Nothing listened for a key. A keyboard user reached
 * the open tab with Tab and then had nowhere to go: Activity and People were
 * unreachable, because `tabindex="-1"` had removed them from the tab order on
 * the promise of a handler that did not exist.
 *
 * That is worse than not having implemented the pattern at all — plain buttons
 * would at least have been reachable. These tests pin the contract the markup
 * was already advertising.
 */

import { describe, expect, it } from 'vitest';

import { buildPaneTabs, type PaneTabId } from '../runtime/pane-tabs';
import { createMockElement, type MockElement } from '../test/obsidian.mock';

import { renderPaneTabs } from './pane-tabs-section';

function flatten(el: MockElement): MockElement[] {
  return [el, ...(el.children ?? []).flatMap(flatten)];
}

function strip(active: PaneTabId = 'status') {
  const root = createMockElement();
  const selected: PaneTabId[] = [];
  renderPaneTabs(root as unknown as HTMLElement, {
    view: buildPaneTabs({ active, attentionCount: 0 }),
    onSelect: (id) => selected.push(id),
  });
  const tabs = flatten(root).filter((el) => el.attrs['role'] === 'tab');
  return { root, tabs, selected };
}

function press(tab: MockElement, key: string): { defaultPrevented: boolean } {
  let defaultPrevented = false;
  tab.triggerEvent('keydown', {
    key,
    preventDefault: () => {
      defaultPrevented = true;
    },
  });
  return { defaultPrevented };
}

describe('tab strip — arrow keys', () => {
  it('moves to the next tab on ArrowRight', () => {
    const { tabs, selected } = strip('status');
    press(tabs[0] as MockElement, 'ArrowRight');
    expect(selected).toEqual(['activity']);
  });

  it('moves to the previous tab on ArrowLeft', () => {
    const { tabs, selected } = strip('activity');
    press(tabs[1] as MockElement, 'ArrowLeft');
    expect(selected).toEqual(['status']);
  });

  it('wraps from the last tab to the first', () => {
    // A tablist is a ring. Stopping at the end makes the user reverse all the
    // way back, which is exactly the friction the pattern exists to remove.
    const { tabs, selected } = strip('people');
    press(tabs[2] as MockElement, 'ArrowRight');
    expect(selected).toEqual(['status']);
  });

  it('wraps from the first tab to the last', () => {
    const { tabs, selected } = strip('status');
    press(tabs[0] as MockElement, 'ArrowLeft');
    expect(selected).toEqual(['people']);
  });

  it('jumps to the first tab on Home and the last on End', () => {
    const { tabs, selected } = strip('activity');
    press(tabs[1] as MockElement, 'Home');
    press(tabs[1] as MockElement, 'End');
    expect(selected).toEqual(['status', 'people']);
  });

  it('leaves other keys to the browser', () => {
    // Tab must still leave the strip, and typing must not be swallowed.
    const { tabs, selected } = strip('status');
    const { defaultPrevented } = press(tabs[0] as MockElement, 'Tab');
    expect(selected).toEqual([]);
    expect(defaultPrevented).toBe(false);
  });

  it('claims the arrow key so the pane does not scroll under it', () => {
    const { tabs } = strip('status');
    expect(press(tabs[0] as MockElement, 'ArrowRight').defaultPrevented).toBe(true);
  });
});

describe('tab strip — focus follows selection', () => {
  it('focuses the newly opened tab', () => {
    // Selecting re-renders the strip, so the tab that gains focus is the one in
    // the NEW tree. Without this the screen reader announces "Activity
    // selected" while the keyboard is still sitting on Status, and the next
    // arrow key moves from the wrong place.
    const root = createMockElement();
    renderPaneTabs(root as unknown as HTMLElement, {
      view: buildPaneTabs({ active: 'activity', attentionCount: 0 }),
      onSelect: () => {},
      focusActive: true,
    });

    const active = flatten(root).find((el) => el.attrs['aria-selected'] === 'true');
    expect(active?.focused).toBe(true);
  });

  it('does not steal focus on a plain render', () => {
    // The pane re-renders on every status change. Grabbing focus each time
    // would rip the caret out of whatever the user was typing.
    const { tabs } = strip('status');
    expect(tabs.some((tab) => tab.focused)).toBe(false);
  });
});

describe('tab strip — roving tabindex', () => {
  it('gives exactly one tab stop', () => {
    const { tabs } = strip('activity');
    expect(tabs.map((tab) => tab.attrs['tabindex'])).toEqual(['-1', '0', '-1']);
  });
});

describe('tab strip — tab and panel are linked', () => {
  it('points each tab at the panel it controls', () => {
    const { tabs } = strip('status');
    for (const tab of tabs) {
      expect(tab.attrs['id']).toBeDefined();
      expect(tab.attrs['aria-controls']).toBe('havemind-tabpanel');
    }
    // Ids must be distinct, or `aria-labelledby` on the panel is ambiguous.
    const ids = tabs.map((tab) => tab.attrs['id']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

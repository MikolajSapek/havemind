/**
 * The tab strip: one row of equal-width tabs under the header.
 *
 * Equal width is the point — the tabs are the plugin's table of contents, and a
 * strip where one tab is twice its neighbour reads as a toolbar with a favourite
 * rather than a set of peers.
 *
 * Each tab is a real `<button>` with `aria-selected`, inside a `role="tablist"`,
 * so a keyboard reaches them in order and a screen reader announces both the
 * name and which one is open. The count beside a label is announced too, via
 * the accessible name, because a bare number next to a word is meaningless when
 * you cannot see the layout.
 */

import { setIcon } from 'obsidian';

import type { PaneTab, PaneTabId, PaneTabsView } from '../runtime/pane-tabs';

import { DECORATIVE } from './primitives';

export interface PaneTabsOptions {
  readonly view: PaneTabsView;
  readonly onSelect: (id: PaneTabId) => void;
  /**
   * Move focus onto the open tab as it renders. Set only on the render that a
   * keyboard selection caused: the pane re-renders on every status change, and
   * grabbing focus each time would pull the caret out of whatever the user was
   * typing. Without it, an arrow key announces the new tab while the keyboard
   * is still on the old one.
   */
  readonly focusActive?: boolean;
}

/** The id of the panel the strip drives, shared with the view that renders it. */
export const PANE_TABPANEL_ID = 'havemind-tabpanel';

/** DOM id for a tab, so the panel can name it through `aria-labelledby`. */
export function paneTabDomId(id: PaneTabId): string {
  return `havemind-tab-${id}`;
}

/** The accessible name: label, count, and whether it wants attention. */
function tabLabel(tab: PaneTab): string {
  const parts = [tab.label];
  if (tab.count !== undefined) parts.push(`${tab.count}`);
  if (tab.needsAttention === true) parts.push('needs attention');
  return parts.join(', ');
}

export function renderPaneTabs(
  content: HTMLElement,
  options: PaneTabsOptions,
): void {
  const strip = content.createDiv();
  strip.addClass('havemind-tabs');
  strip.setAttribute('role', 'tablist');

  const ids = options.view.tabs.map((tab) => tab.id);

  for (const [index, tab] of options.view.tabs.entries()) {
    const active = tab.id === options.view.active;
    const button = strip.createEl('button', {
      attr: {
        role: 'tab',
        id: paneTabDomId(tab.id),
        'aria-controls': PANE_TABPANEL_ID,
        'aria-selected': active ? 'true' : 'false',
        'aria-label': tabLabel(tab),
        // Only the open tab is a tab stop; arrow keys move within the strip,
        // matching how a tablist is expected to behave.
        tabindex: active ? '0' : '-1',
      },
    });

    // The strip is a ring: Right from the last tab lands on the first. Stopping
    // at the end would make the user reverse across the whole strip, which is
    // the friction the roving tabindex exists to remove.
    button.addEventListener('keydown', (event: unknown) => {
      const key = (event as { key?: string }).key;
      const step =
        key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : undefined;

      let next: PaneTabId | undefined;
      if (step !== undefined) {
        next = ids[(index + step + ids.length) % ids.length];
      } else if (key === 'Home') {
        next = ids[0];
      } else if (key === 'End') {
        next = ids[ids.length - 1];
      }

      if (next === undefined) return; // Tab, typing, everything else: not ours.
      // Claim the key so the pane underneath does not also scroll on it.
      (event as { preventDefault?: () => void }).preventDefault?.();
      options.onSelect(next);
    });
    button.addClass('havemind-tab');
    if (active) button.addClass('is-active');
    if (tab.needsAttention === true) button.addClass('needs-attention');

    const icon = button.createEl('span', { attr: DECORATIVE });
    icon.addClass('havemind-tab-icon');
    setIcon(icon, tab.icon);

    button.createEl('span', { text: tab.label }).addClass('havemind-tab-label');

    if (tab.count !== undefined) {
      button
        .createEl('span', { text: `${tab.count}` })
        .addClass('havemind-tab-count');
    }

    button.onClickEvent(() => options.onSelect(tab.id));

    // Selecting re-renders the strip, so the element that takes focus is the
    // one in the NEW tree — not the button that was pressed, which no longer
    // exists by the time this runs.
    if (active && options.focusActive === true) button.focus();
  }
}

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

  for (const tab of options.view.tabs) {
    const active = tab.id === options.view.active;
    const button = strip.createEl('button', {
      attr: {
        role: 'tab',
        'aria-selected': active ? 'true' : 'false',
        'aria-label': tabLabel(tab),
        // Only the open tab is a tab stop; arrow keys move within the strip,
        // matching how a tablist is expected to behave.
        tabindex: active ? '0' : '-1',
      },
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
  }
}

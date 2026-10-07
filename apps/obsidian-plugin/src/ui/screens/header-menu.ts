/**
 * What the pane's "More options" menu holds, and how it becomes a native menu.
 *
 * Only offered once connected: on the connect screen there is nothing to
 * disconnect from, and Reset is surfaced as its own button in the one state that
 * needs it. The two items that end the connection come last, in their own
 * section, rendered red by Obsidian (`setWarning`); each asks before it acts.
 *
 * The item list is pure, so the ORDER, which is the part that matters, is
 * testable without a pane. The native `Menu` gives Escape, click-outside and the
 * phone's bottom sheet for free, which the old inline menu never had.
 */

import { Menu } from 'obsidian';

import type { ConnectionPanelView } from '../../runtime/status';

/** One entry in the pane's options menu. */
export interface PaneMenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  /** Ends or resets the connection: rendered red, kept in its own section. */
  readonly warning?: boolean;
}

export interface HeaderMenuActions {
  readonly onSyncNow?: (() => void) | undefined;
  readonly onDisconnect?: (() => void) | undefined;
  readonly onReset?: (() => void) | undefined;
  readonly onToggleHelp: () => void;
}

export function buildHeaderMenuItems(
  panel: ConnectionPanelView,
  helpOpen: boolean,
  actions: HeaderMenuActions,
): PaneMenuItem[] {
  if (panel.showForm) return [];
  const items: PaneMenuItem[] = [];
  // Sync is automatic; forcing a cycle is the rare exception, so it lives here.
  if (actions.onSyncNow) items.push({ label: 'Sync now', onSelect: actions.onSyncNow });
  // Read once, then never again: exactly what an overflow menu is for.
  items.push({
    label: helpOpen ? 'Hide getting started' : 'Show getting started',
    onSelect: actions.onToggleHelp,
  });
  if (actions.onDisconnect) {
    items.push({ label: 'Disconnect…', onSelect: actions.onDisconnect, warning: true });
  }
  if (actions.onReset) {
    items.push({ label: 'Reset connection…', onSelect: actions.onReset, warning: true });
  }
  return items;
}

/** Adds the items to a native menu (the pane's own, or the view header's). */
export function fillPaneMenu(menu: Menu, items: readonly PaneMenuItem[]): void {
  for (const entry of items) {
    menu.addItem((item) => {
      item
        .setTitle(entry.label)
        .setSection(entry.warning === true ? 'danger' : 'havemind')
        .onClick(() => entry.onSelect());
      if (entry.warning === true) item.setWarning(true);
    });
  }
}

/** Shows the items as a native menu where the pointer is. */
export function showPaneMenu(event: MouseEvent, items: readonly PaneMenuItem[]): void {
  const menu = new Menu();
  fillPaneMenu(menu, items);
  menu.showAtMouseEvent(event);
}

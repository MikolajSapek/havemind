/**
 * What the header overflow menu holds.
 *
 * Only offered once connected: on the connect screen there is nothing to
 * disconnect from, and Reset is already surfaced as its own affordance in the
 * one state that needs it.
 *
 * Pure: it builds the item list and nothing else, so the ORDER, which is the
 * part that matters, is testable without a pane. Context ("Server: …") comes
 * after the actions deliberately, so it cannot split the destructive and
 * recovery choices from each other.
 */

import type { ConnectionPanelView } from '../../runtime/status';
import type { PaneMenuItem } from '../pane-header';

export interface HeaderMenuActions {
  /** Present only when the plugin wired the corresponding action. */
  readonly onSyncNow?: (() => void) | undefined;
  readonly onDisconnect?: (() => void) | undefined;
  readonly onReset?: (() => void) | undefined;
  /** Selection handlers, which also close the menu. */
  readonly onSelectSyncNow?: (() => void) | undefined;
  readonly onSelectDisconnect?: (() => void) | undefined;
  readonly onSelectReset?: (() => void) | undefined;
  readonly onToggleHelp: () => void;
}

export function buildHeaderMenuItems(
  panel: ConnectionPanelView,
  helpOpen: boolean,
  actions: HeaderMenuActions,
): PaneMenuItem[] {
    if (panel.showForm) return [];

    const items: PaneMenuItem[] = [];

    // Sync is automatic; a standing button implies it might not be. It lives
    // here for the rare case where forcing a cycle actually helps (round 2, Q5).
    if (actions.onSyncNow) {
      items.push({
        label: 'Sync now',
        onSelect: () => actions.onSelectSyncNow?.(),
      });
    }

    // Getting started lost its icon with the action row. It is read once and
    // then never again, which is exactly what the overflow menu is for, but it
    // must stay reachable, so it moves here rather than disappearing.
    items.push({
      label: helpOpen ? 'Hide getting started' : 'Show getting started',
      onSelect: () => actions.onToggleHelp(),
    });
    if (actions.onDisconnect) {
      items.push({
        label: 'Disconnect',
        onSelect: () => actions.onSelectDisconnect?.(),
      });
    }
    if (actions.onReset) {
      items.push({
        label: 'Reset connection',
        onSelect: () => actions.onSelectReset?.(),
      });
    }
    // Context belongs after the actions: it is useful for confirmation, but
    // must not split the menu's destructive/recovery choices.
    if (panel.serverName !== undefined) {
      items.push({
        label: `Server: ${panel.serverName}`,
        onSelect: () => {},
        readOnly: true,
      });
    }
    return items;
}

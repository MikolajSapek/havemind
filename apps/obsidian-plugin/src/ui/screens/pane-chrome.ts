/**
 * The pane header: the mark, the title, the view actions and the overflow menu.
 *
 * Disconnect, Reset and the server address live behind the menu rather than
 * costing standing lines in a 300px column. The view actions (author overlay,
 * Invite) appear only once connected: before that there is nothing to colour
 * and nobody to invite.
 *
 * Extracted from `render()` for Stage 3.
 */

import type { ConnectionPanelView } from '../../runtime/status';
import { renderPaneHeader, type PaneMenuItem } from '../pane-header';

export interface PaneChromeOptions {
  readonly panel: ConnectionPanelView;
  readonly menuOpen: boolean;
  readonly alarmed: boolean;
  readonly overlayOn: boolean | undefined;
  readonly items: PaneMenuItem[];
  readonly onToggleMenu: () => void;
  readonly onToggleAuthorOverlay?: (() => void) | undefined;
  readonly onInvite?: (() => void) | undefined;
}

export function renderPaneChrome(
  content: HTMLElement,
  options: PaneChromeOptions,
): void {
  const { panel, overlayOn } = options;
  renderPaneHeader(content, {
    title: 'Havemind',
    menuOpen: options.menuOpen,
    onToggleMenu: options.onToggleMenu,
    items: options.items,
    alarmed: options.alarmed,
    // Only once connected, hence the `showForm` guard on each.
    ...(panel.showForm || overlayOn === undefined ? {} : { authorOverlayOn: overlayOn }),
    ...(panel.showForm || options.onToggleAuthorOverlay === undefined
      ? {}
      : { onToggleAuthorOverlay: options.onToggleAuthorOverlay }),
    ...(panel.showForm || options.onInvite === undefined
      ? {}
      : { onInvite: options.onInvite }),
  });
}

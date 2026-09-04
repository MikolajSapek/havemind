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
import type { OnboardingViewOptions } from '../onboarding-types';
import { renderPaneHeader, type PaneMenuItem } from '../pane-header';
import { safeRead } from '../primitives';

import { buildHeaderMenuItems } from './header-menu';
import { attentionCount } from './tab-screens';

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

/** The flags the chrome reads, all owned by the view. */
export interface PaneChromeState {
  readonly menuOpen: boolean;
  readonly helpOpen: boolean;
}

/** The three things selecting a chrome control has to be able to do. */
export interface PaneChromeCallbacks {
  readonly setMenuOpen: (open: boolean) => void;
  readonly setHelpOpen: (open: boolean) => void;
  readonly repaint: () => void;
}

/**
 * Draws the chrome straight from the options bag.
 *
 * Every menu selection closes the menu, so the wrapper states that once instead
 * of repeating it, and forgetting it, on each item.
 */
export function renderPaneChromeFor(
  content: HTMLElement,
  panel: ConnectionPanelView,
  options: OnboardingViewOptions,
  state: PaneChromeState,
  callbacks: PaneChromeCallbacks,
): void {
  const closeMenu = (run?: () => void) => () => {
    callbacks.setMenuOpen(false);
    run?.();
  };
  renderPaneChrome(content, {
    panel,
    menuOpen: state.menuOpen,
    alarmed: attentionCount(options) > 0,
    overlayOn: safeRead('authorOverlay', options.authorOverlayProvider, undefined),
    items: buildHeaderMenuItems(panel, state.helpOpen, {
      onSyncNow: options.onSyncNow,
      onDisconnect: options.onDisconnect,
      onReset: options.onReset,
      onSelectSyncNow: closeMenu(options.onSyncNow),
      onSelectDisconnect: closeMenu(options.onDisconnect),
      onSelectReset: closeMenu(options.onReset),
      onToggleHelp: () => {
        callbacks.setHelpOpen(!state.helpOpen);
        callbacks.setMenuOpen(false);
        callbacks.repaint();
      },
    }),
    onToggleMenu: () => {
      callbacks.setMenuOpen(!state.menuOpen);
      callbacks.repaint();
    },
    onToggleAuthorOverlay: options.onToggleAuthorOverlay,
    onInvite: options.onOpenComposer,
  });
}

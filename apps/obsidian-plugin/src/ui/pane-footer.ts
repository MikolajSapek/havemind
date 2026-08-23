/**
 * The pane action bar (design 2a).
 *
 * Sits directly under the header, mirroring Obsidian's own
 * `nav-buttons-container`: a row of icon buttons for the things a connected
 * user reaches for — authorship, invite, sync now, getting started.
 *
 * Design 1a put these at the bottom of the pane. 2a moves them up into native
 * chrome, so the plugin reads as part of Obsidian rather than a panel wearing
 * its own furniture.
 *
 * Every button is icon-only, so each carries an `aria-label` naming the action.
 * The authorship toggle additionally carries `aria-pressed`, because its state
 * must survive a user who cannot see the accent fill: colour is never the only
 * signal.
 */

import { setIcon } from 'obsidian';


export interface PaneFooterOptions {
  /** Current author-overlay state, or undefined to omit the toggle. */
  readonly authorOverlayOn?: boolean;
  readonly onToggleAuthorOverlay?: () => void;
  readonly onCreateInvitation?: () => void;
  /** Forces an immediate sync cycle, matching the `sync-now` command. */
  readonly onSyncNow?: () => void;
  readonly onOpenHelp?: () => void;
  /** Whether the getting-started panel is currently open, for `aria-expanded`. */
  readonly helpOpen?: boolean;
}

export function renderPaneFooter(
  content: HTMLElement,
  options: PaneFooterOptions,
): void {
  const hasToggle =
    options.authorOverlayOn !== undefined &&
    options.onToggleAuthorOverlay !== undefined;
  if (!hasToggle && !options.onCreateInvitation && !options.onOpenHelp) return;

  const bar = content.createDiv();
  bar.addClass('havemind-nav-bar');

  if (hasToggle) {
    const on = options.authorOverlayOn === true;
    const toggle = bar.createEl('button', {
      attr: {
        'aria-label': 'Show authorship colours',
        'aria-pressed': on ? 'true' : 'false',
      },
    });
    toggle.addClass('havemind-nav-action');
    if (on) toggle.addClass('is-on');
    setIcon(toggle, 'users');
    toggle.onClickEvent(() => options.onToggleAuthorOverlay?.());
  }

  if (options.onCreateInvitation) {
    const invite = bar.createEl('button', {
      attr: { 'aria-label': 'Create invitation' },
    });
    invite.addClass('havemind-nav-action');
    setIcon(invite, 'user-plus');
    invite.onClickEvent(() => options.onCreateInvitation?.());
  }

  if (options.onSyncNow) {
    const sync = bar.createEl('button', {
      attr: { 'aria-label': 'Sync now' },
    });
    sync.addClass('havemind-nav-action');
    setIcon(sync, 'refresh-cw');
    sync.onClickEvent(() => options.onSyncNow?.());
  }

  if (options.onOpenHelp) {
    const open = options.helpOpen === true;
    const help = bar.createEl('button', {
      attr: {
        // The label states the action, not the object, so a screen reader
        // announces what the press will do rather than where it lands.
        'aria-label': open ? 'Hide getting started' : 'Show getting started',
        'aria-expanded': open ? 'true' : 'false',
      },
    });
    // Help parks at the far end, away from the actions that change the vault.
    help.addClass('havemind-nav-action');
    help.addClass('havemind-nav-end');
    setIcon(help, 'life-buoy');
    help.onClickEvent(() => options.onOpenHelp?.());
  }
}

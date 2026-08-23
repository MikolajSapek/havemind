/**
 * The pane footer: the authorship toggle and two icon actions (design 1a).
 *
 * Authorship lost its ribbon icon when the plugin collapsed to one hexagon
 * (plans/007 Stage 0). It belongs here — beside the vault it annotates —
 * rather than in a global strip shared with every other plugin.
 *
 * The toggle carries `aria-pressed` because its state must survive a user who
 * cannot see the accent fill: colour is never the only signal.
 */

import { setIcon } from 'obsidian';

import { DECORATIVE } from './primitives';

export interface PaneFooterOptions {
  /** Current author-overlay state, or undefined to omit the toggle. */
  readonly authorOverlayOn?: boolean;
  readonly onToggleAuthorOverlay?: () => void;
  readonly onCreateInvitation?: () => void;
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

  const footer = content.createDiv();
  footer.addClass('havemind-pane-footer');

  if (hasToggle) {
    const on = options.authorOverlayOn === true;
    const toggle = footer.createEl('button', {
      attr: { 'aria-pressed': on ? 'true' : 'false' },
    });
    toggle.addClass('havemind-footer-toggle');
    if (on) toggle.addClass('is-on');
    const icon = toggle.createEl('span', { attr: DECORATIVE });
    setIcon(icon, 'users');
    toggle.createEl('span', { text: 'Authorship' });
    toggle.onClickEvent(() => options.onToggleAuthorOverlay?.());
  }

  const actions = footer.createDiv();
  actions.addClass('havemind-footer-actions');

  if (options.onCreateInvitation) {
    const invite = actions.createEl('button', {
      attr: { 'aria-label': 'Create invitation' },
    });
    invite.addClass('havemind-footer-action');
    setIcon(invite, 'user-plus');
    invite.onClickEvent(() => options.onCreateInvitation?.());
  }

  if (options.onOpenHelp) {
    const open = options.helpOpen === true;
    const help = actions.createEl('button', {
      attr: {
        // The label states the action, not the object, so a screen reader
        // announces what the press will do rather than where it lands.
        'aria-label': open ? 'Hide getting started' : 'Show getting started',
        'aria-expanded': open ? 'true' : 'false',
      },
    });
    help.addClass('havemind-footer-action');
    setIcon(help, 'life-buoy');
    help.onClickEvent(() => options.onOpenHelp?.());
  }
}

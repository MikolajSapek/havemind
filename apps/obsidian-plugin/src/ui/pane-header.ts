/**
 * The pane header strip: hexagon, name, and an overflow menu (design 1a).
 *
 * The actions behind the menu, Disconnect, Reset, and the server address,
 * used to occupy a standing block in the pane. Nobody needs their own server
 * address daily, and a permanent Disconnect button spends a line on the one
 * action a connected user least wants to hit. They move here, one click away,
 * and the column gets those lines back for things that change.
 */

import { setIcon } from 'obsidian';

import { DECORATIVE } from './primitives';

/** One entry in the header overflow menu. */
export interface PaneMenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  /** Rendered muted and non-interactive, used for the server address. */
  readonly readOnly?: boolean;
}

export interface PaneHeaderOptions {
  readonly title: string;
  readonly items: readonly PaneMenuItem[];
  /** Whether the menu is currently open; the caller owns the flag. */
  readonly menuOpen: boolean;
  readonly onToggleMenu: () => void;
  /**
   * View actions, rendered in the header itself rather than in a second row
   * below it (round 2, Q1). Two rows of icons is one row too many, and Obsidian
   * already has a place for view actions: the view header. Moving them costs no
   * new chrome and removes the read of "eight equal buttons", header icons are
   * visibly chrome, tabs are visibly navigation.
   */
  readonly authorOverlayOn?: boolean;
  readonly onToggleAuthorOverlay?: () => void;
  readonly onInvite?: () => void;
  /**
   * True when something needs the user. Marks the pane's own hexagon, so a
   * collapsed or background pane still signals it, the alarm block itself
   * renders below regardless.
   */
  readonly alarmed?: boolean;
}

/**
 * Renders the header strip. The menu is drawn inline rather than as a floating
 * layer: a created element gets no Obsidian popover behaviour for free, and an
 * inline disclosure is reachable by keyboard without inventing focus handling.
 */
export function renderPaneHeader(
  content: HTMLElement,
  options: PaneHeaderOptions,
): void {
  const strip = content.createDiv();
  strip.addClass('havemind-pane-header');

  const markWrap = strip.createDiv();
  markWrap.addClass('havemind-pane-mark');
  const mark = markWrap.createEl('span', { attr: DECORATIVE });
  setIcon(mark, 'hexagon');
  if (options.alarmed === true) {
    // A dot on the mark itself, so a pane that is collapsed or behind another
    // still signals. Paired with the alarm block below and a title attribute,
    // never colour alone.
    const dot = markWrap.createEl('span', {
      attr: { title: 'Needs attention' },
    });
    dot.addClass('havemind-pane-mark-dot');
  }

  strip.createEl('span', { text: options.title, cls: 'havemind-pane-title' });

  if (
    options.authorOverlayOn !== undefined &&
    options.onToggleAuthorOverlay !== undefined
  ) {
    const on = options.authorOverlayOn;
    const toggle = strip.createEl('button', {
      attr: {
        'aria-label': 'Authorship colours',
        'aria-pressed': on ? 'true' : 'false',
      },
    });
    toggle.addClass('havemind-header-action');
    if (on) toggle.addClass('is-on');
    setIcon(toggle, 'eye');
    toggle.onClickEvent(() => options.onToggleAuthorOverlay?.());
  }

  if (options.onInvite !== undefined) {
    const invite = strip.createEl('button', {
      attr: { 'aria-label': 'Invite someone' },
    });
    invite.addClass('havemind-header-action');
    setIcon(invite, 'user-plus');
    invite.onClickEvent(() => options.onInvite?.());
  }

  const more = strip.createEl('button', {
    attr: {
      'aria-label': 'More options',
      'aria-expanded': options.menuOpen ? 'true' : 'false',
    },
  });
  more.addClass('havemind-header-action');
  more.addClass('havemind-pane-more');
  setIcon(more, 'more-horizontal');
  more.onClickEvent(() => options.onToggleMenu());

  if (!options.menuOpen) return;

  const menu = content.createDiv();
  menu.addClass('havemind-pane-menu');
  let renderedAction = false;
  for (const item of options.items) {
    if (item.readOnly === true) {
      if (renderedAction) {
        menu.createDiv().addClass('havemind-pane-menu-sep');
      }
      menu.createDiv({ text: item.label }).addClass('havemind-pane-menu-note');
      continue;
    }
    const entry = menu.createEl('button', { text: item.label });
    entry.addClass('havemind-pane-menu-item');
    entry.onClickEvent(() => item.onSelect());
    renderedAction = true;
  }
}

/**
 * The pane header strip: hexagon, name, and an overflow menu (design 1a).
 *
 * The actions behind the menu — Disconnect, Reset, and the server address —
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
  /** Rendered muted and non-interactive — used for the server address. */
  readonly readOnly?: boolean;
}

export interface PaneHeaderOptions {
  readonly title: string;
  readonly items: readonly PaneMenuItem[];
  /** Whether the menu is currently open; the caller owns the flag. */
  readonly menuOpen: boolean;
  readonly onToggleMenu: () => void;
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

  const mark = strip.createEl('span', { attr: DECORATIVE });
  mark.addClass('havemind-pane-mark');
  setIcon(mark, 'hexagon');

  strip.createEl('span', { text: options.title, cls: 'havemind-pane-title' });

  const more = strip.createEl('button', {
    attr: {
      'aria-label': 'More options',
      'aria-expanded': options.menuOpen ? 'true' : 'false',
    },
  });
  more.addClass('havemind-pane-more');
  setIcon(more, 'more-horizontal');
  more.onClickEvent(() => options.onToggleMenu());

  if (!options.menuOpen) return;

  const menu = content.createDiv();
  menu.addClass('havemind-pane-menu');
  for (const item of options.items) {
    if (item.readOnly === true) {
      menu.createDiv({ text: item.label }).addClass('havemind-pane-menu-note');
      continue;
    }
    const entry = menu.createEl('button', { text: item.label });
    entry.addClass('havemind-pane-menu-item');
    entry.onClickEvent(() => item.onSelect());
  }
}

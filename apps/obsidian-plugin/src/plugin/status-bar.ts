/** The status bar: the sync state, as a button that opens the pane, and who last edited the open note. */

import { type EventRef } from 'obsidian';

import type HavemindPlugin from '../main';
import { lastEditedLabel } from '../runtime/last-edited';
import { formatStatusBar, type StatusBarView } from '../runtime/status';
import { DECORATIVE } from '../ui/primitives';

/** Flat-top hexagon in a 28 x 24 box, and its lower-right half for a conflict. */
const HEXAGON = 'M24 12L19 20.7H9L4 12L9 3.3H19Z';
const SPLIT = 'M20.3 5.7L24 12L19 20.7H9L7.7 18.3Z';

export class StatusBar {
  private statusItem: HTMLElement | null = null;
  /** Status bar item naming who last edited the open note. */
  private lastEditedItem: HTMLElement | null = null;
  private glyph: SVGSVGElement | null = null;
  private label: HTMLElement | null = null;
  private glyphState: StatusBarView['status'] | null = null;

  public constructor(private readonly plugin: HavemindPlugin) {}

  /** Adds both items; `onload` calls this once. */
  public attach(): void {
    this.statusItem = this.plugin.addStatusBarItem();
    this.statusItem.addClass('havemind-status-bar');
    // The status bar is text-only (setText clobbers children), so the Retry
    // button lives in the panel. Clicking the status bar item opens that panel,
    // the one place the button and full status detail render. The click listener
    // sits on the element itself, so subsequent setStatus text updates keep it.
    this.statusItem.onClickEvent(() => {
      void this.plugin.openPane();
    });
    // The item is a real control, so it must say so and be reachable without a
    // mouse: the role and name make it announce itself as "Open Havemind panel,
    // button", the tabindex puts it in the tab order, and Enter/Space open the
    // same panel the click opens. Attributes live on the element itself, so the
    // setStatus rebuild (which only replaces children) keeps them.
    this.statusItem.setAttribute('role', 'button');
    this.statusItem.setAttribute('tabindex', '0');
    this.statusItem.setAttribute('aria-label', 'Open Havemind panel');
    this.plugin.registerDomEvent(this.statusItem, 'keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return;
      // Space would otherwise scroll the pane behind the status bar.
      keyboardEvent.preventDefault();
      void this.plugin.openPane();
    });
    this.setStatus(formatStatusBar({ status: 'disconnected' }));

    // Who last edited the open note, from the server-stamped revision author.
    this.lastEditedItem = this.plugin.addStatusBarItem();
    const workspace = this.plugin.app.workspace as unknown as {
      on?: (name: string, handler: () => void) => unknown;
    };
    const fileOpen = workspace.on?.('file-open', () => {
      void this.refreshLastEdited();
    });
    if (fileOpen !== undefined && fileOpen !== null) {
      this.plugin.registerEvent(fileOpen as EventRef);
    }
  }

  public setStatus(view: StatusBarView): void {
    const item = this.statusItem;
    if (item === null) return;
    // Built once, then updated in place: a rebuilt glyph would restart its
    // pulse or march on every repaint, which reads as flicker.
    if (this.glyph === null || this.label === null) {
      item.empty();
      // The smallest flower: one hexagon whose shape is the state (plan 010),
      // filled when synced, pulsing while syncing, dashed when out of reach,
      // split on a conflict. Geometry here, look in styles.css.
      const holder = item.createEl('span', { attr: DECORATIVE });
      const svg = holder.createSvg('svg', {
        cls: 'havemind-status-glyph',
        attr: { viewBox: '0 0 28 24', width: '16', height: '14' },
      });
      svg.createSvg('path', { cls: 'havemind-status-glyph-ring', attr: { d: HEXAGON } });
      svg.createSvg('path', { cls: 'havemind-status-glyph-hex', attr: { d: HEXAGON } });
      svg.createSvg('path', { cls: 'havemind-status-glyph-split', attr: { d: SPLIT } });
      this.glyph = svg;
      // Kept deliberately: with the pane closed the status bar is the ONLY
      // surface showing sync state, and a shape alone is unreadable to anyone
      // who cannot see it. Here the words are the whole accessible signal.
      this.label = item.createEl('span');
    }
    if (this.glyphState !== view.status) {
      if (this.glyphState !== null) this.glyph.removeClass(`is-${this.glyphState}`);
      this.glyph.addClass(`is-${view.status}`);
      this.glyphState = view.status;
    }
    this.label.setText(view.text);
  }

  /** Names the last editor of the open note in the status bar. */
  public async refreshLastEdited(): Promise<void> {
    const item = this.lastEditedItem;
    if (item === null) return;
    const file = (this.plugin.app.workspace as { getActiveFile?: () => { path: string } | null })
      .getActiveFile?.();
    const fileId = file === null || file === undefined ? null : this.plugin.syncState?.fileIdAtPath(file.path) ?? null;
    let author: string | null = null;
    if (fileId !== null) {
      try {
        author = (await this.plugin.connection?.lastAuthor?.(fileId)) ?? null;
      } catch {
        author = null;
      }
    }
    item.setText(lastEditedLabel(author, this.plugin.people.rosterMembers));
  }
}

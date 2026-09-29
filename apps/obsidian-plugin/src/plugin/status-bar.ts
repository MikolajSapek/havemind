/** The status bar: the sync state, as a button that opens the pane, and who last edited the open note. */

import { setIcon, type EventRef } from 'obsidian';

import type HavemindPlugin from '../main';
import { lastEditedLabel } from '../runtime/last-edited';
import { formatStatusBar, type StatusBarView } from '../runtime/status';
import { DECORATIVE } from '../ui/primitives';

export class StatusBar {
  private statusItem: HTMLElement | null = null;
  /** Status bar item naming who last edited the open note. */
  private lastEditedItem: HTMLElement | null = null;

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
    // A leading hive-hexagon glyph precedes the stable label. setText would
    // clobber the glyph, so rebuild the item: glyph first, then the same text
    // in a trailing span. The label string and tooltip are unchanged.
    item.empty();
    const glyph = item.createEl('span', { attr: DECORATIVE });
    setIcon(glyph, 'hexagon');
    // Design 1a proposes cutting this label as a duplicate of the pane. Kept
    // deliberately: with the pane closed the status bar is the ONLY surface
    // showing sync state, and a bare mark plus a colour dot is unreadable to
    // anyone who cannot see the colour. The pane is where words are optional;
    // here they are the whole accessible signal.
    item.createEl('span', { text: view.text });
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

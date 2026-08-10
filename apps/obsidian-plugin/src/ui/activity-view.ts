/**
 * The Havemind Activity view: the F5-01 revision feed and its per-row Restore
 * action. The class owns nothing but rendering — the live feed and the restore
 * handler are injected as options by the plugin, and the row wording, ordering
 * and author colours come from the pure `buildActivityViewModel` helper — so the
 * view can be constructed in a headless test with a stub leaf and a fixed feed.
 */

import { ItemView, type WorkspaceLeaf } from 'obsidian';

import type { RevisionRecord } from '../activity/activity';
import { buildActivityViewModel } from '../runtime/activity-render';

import { formatActivityTime, renderSection, renderViewTitle } from './primitives';
import { HAVEMIND_ACTIVITY_VIEW } from './view-types';

const EMPTY_ACTIVITY_TEXT =
  'No activity yet. Connect to a vault to see changes as they happen.';

/** Injected data + actions for the Activity surface (F5-01 feed + restore). */
export interface ActivityViewOptions {
  readonly feedProvider?: () => readonly RevisionRecord[];
  readonly onRestore?: (revisionId: string) => void;
}

export class HavemindActivityView extends ItemView {
  private readonly options: ActivityViewOptions;

  constructor(leaf: WorkspaceLeaf, options: ActivityViewOptions = {}) {
    super(leaf);
    this.options = options;
  }

  override getDisplayText(): string {
    return 'Havemind activity';
  }

  override getIcon(): string {
    return 'hexagon';
  }

  override getViewType(): string {
    return HAVEMIND_ACTIVITY_VIEW;
  }

  override onOpen(): void {
    this.render();
  }

  /** Re-renders from the live feed — called when the activity log changes. */
  refresh(): void {
    this.render();
  }

  private render(): void {
    const content = this.containerEl.children[1] as HTMLElement | undefined;
    if (!content) return;

    content.empty();
    content.addClass('havemind-view');
    renderViewTitle(content, 'Havemind activity');

    // MAJOR 5: a throw building or rendering the feed degrades to an inline
    // fallback rather than blanking the activity view.
    renderSection(content, 'activity', () => {
      const model = buildActivityViewModel(this.options.feedProvider?.() ?? [], {
        formatTimestamp: formatActivityTime,
      });
      if (model.empty) {
        const empty = content.createDiv({ text: EMPTY_ACTIVITY_TEXT });
        empty.addClass('havemind-empty');
        return;
      }

      for (const row of model.rows) {
        const entry = content.createDiv();
        entry.addClass('havemind-activity-row');
        // Two-line row: `author verb` headline over the vault path. The full
        // `kind · path · actor` string still lives on `row.label` for anything
        // that reads it; nothing about the data changes.
        const text = entry.createDiv();
        text.createDiv({ text: row.headline });
        text.createDiv({ text: row.pathLabel }).addClass('havemind-hint');
        // Author colour as a left accent, paired with the author name already in
        // the headline — colour is never the only signal (accessibility rule).
        entry.style.setProperty('--havemind-row-color', `var(${row.colorToken})`);
        // The Restore button stays the first child so the F5 restore contract is
        // unchanged; the time is appended after it.
        if (row.canRestore && this.options.onRestore) {
          const restore = entry.createEl('button', { text: 'Restore' });
          restore.addClass('havemind-activity-action');
          restore.onClickEvent(() => this.options.onRestore?.(row.revisionId));
        }
        const time = entry.createEl('span', { text: ` ${row.timeLabel}` });
        time.addClass('havemind-activity-time');
      }
    });
  }
}

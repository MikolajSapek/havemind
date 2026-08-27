/**
 * The Havemind Activity view: the F5-01 revision feed and its per-row Restore
 * action. The class owns nothing but rendering, the live feed and the restore
 * handler are injected as options by the plugin, and the row wording, ordering
 * and author colours come from the pure `buildActivityViewModel` helper, so the
 * view can be constructed in a headless test with a stub leaf and a fixed feed.
 */

import { ItemView, type WorkspaceLeaf } from 'obsidian';

import type { RevisionRecord } from '../activity/activity';

import { renderActivityRows } from './activity-section';
import { renderSection, renderViewTitle } from './primitives';
import { HAVEMIND_ACTIVITY_VIEW } from './view-types';

/** Injected data + actions for the Activity surface (F5-01 feed + restore). */
export interface ActivityViewOptions {
  readonly feedProvider?: () => readonly RevisionRecord[];
  readonly onRestore?: (revisionId: string) => void;
  /** Releases the plugin's active-view reference when Obsidian closes this leaf. */
  readonly onClosed?: () => void;
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

  override onClose(): void {
    this.options.onClosed?.();
  }

  /** Re-renders from the live feed, called when the activity log changes. */
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
      renderActivityRows(content, {
        feed: this.options.feedProvider?.() ?? [],
        ...(this.options.onRestore ? { onRestore: this.options.onRestore } : {}),
      });
    });
  }
}

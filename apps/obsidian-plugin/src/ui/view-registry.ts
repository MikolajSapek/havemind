/** A live plugin view that can repaint when its backing state changes. */
export interface RefreshablePluginView {
  refresh(): void;
  /** Repaints without waiting, for a change the user just caused. */
  refreshNow?(): void;
}

/**
 * Owns the short-lived references to views created by Obsidian.
 *
 * A plugin state change may occur after a leaf closes. Holding the old ItemView
 * in the plugin would retain its DOM and send refreshes into a dead surface, so
 * registration returns an identity-safe disposer for the view's `onClose`.
 */
/**
 * One slot, because UI-00 left one registered view type: the pane's Activity
 * tab repaints through `refreshOnboarding` like every other tab.
 */
export class PluginViewRegistry {
  private onboarding: RefreshablePluginView | null = null;

  registerOnboarding(view: RefreshablePluginView): () => void {
    this.onboarding = view;
    return () => this.unregisterOnboarding(view);
  }

  unregisterOnboarding(view: RefreshablePluginView): void {
    if (this.onboarding === view) this.onboarding = null;
  }

  refreshOnboarding(): void {
    this.onboarding?.refresh();
  }

  /**
   * Repaints the pane at once, for a change the user just caused by tapping.
   *
   * `refreshOnboarding` coalesces, which is right for events arriving from the
   * server but wrong for a tap: nobody is waiting on a specific frame there,
   * and here somebody is.
   */
  refreshOnboardingNow(): void {
    const view = this.onboarding;
    if (view?.refreshNow !== undefined) view.refreshNow();
    else view?.refresh();
  }
}

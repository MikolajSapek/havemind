/** A live plugin view that can repaint when its backing state changes. */
export interface RefreshablePluginView {
  refresh(): void;
}

/**
 * Owns the short-lived references to views created by Obsidian.
 *
 * A plugin state change may occur after a leaf closes. Holding the old ItemView
 * in the plugin would retain its DOM and send refreshes into a dead surface, so
 * registration returns an identity-safe disposer for the view's `onClose`.
 */
export class PluginViewRegistry {
  private onboarding: RefreshablePluginView | null = null;
  private activity: RefreshablePluginView | null = null;

  registerOnboarding(view: RefreshablePluginView): () => void {
    this.onboarding = view;
    return () => this.unregisterOnboarding(view);
  }

  registerActivity(view: RefreshablePluginView): () => void {
    this.activity = view;
    return () => this.unregisterActivity(view);
  }

  unregisterOnboarding(view: RefreshablePluginView): void {
    if (this.onboarding === view) this.onboarding = null;
  }

  unregisterActivity(view: RefreshablePluginView): void {
    if (this.activity === view) this.activity = null;
  }

  refreshOnboarding(): void {
    this.onboarding?.refresh();
  }

  refreshActivity(): void {
    this.activity?.refresh();
  }
}

/**
 * The two contracts the settings tab and the plugin agree on: the read-only
 * facts the tab displays, and the connection actions it invokes. They live in
 * their own type-only module so the plugin can declare the return types of
 * `settingsInfo()` and `connectionActions()` without importing the tab class,
 * and the tab can read them without importing the plugin's implementation.
 */

/** The read-only facts the settings tab shows, all already known locally. */
export interface HavemindSettingsInfo {
  /** Server host from the live connection handle, or a plain "not connected". */
  readonly server: string;
  /** The same status wording the panel and status bar use. */
  readonly status: string;
  readonly lastSync: string;
  readonly members: string;
  /** Whether a live connection exists, gates the sync/disconnect actions. */
  readonly connected: boolean;
}

/**
 * The connection actions, defined once by the plugin and shared by the command
 * palette entries and the settings-tab buttons.
 */
export interface HavemindConnectionActions {
  readonly syncNow: () => void;
  readonly disconnect: () => void;
  readonly resetConnection: () => void;
  /** Availability of `syncNow`/`disconnect`, meaningless while disconnected. */
  readonly connected: () => boolean;
}

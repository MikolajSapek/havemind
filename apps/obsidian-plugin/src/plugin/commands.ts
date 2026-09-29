/** The command palette entries and the ribbon icon; each one lands in the single pane. */

import type HavemindPlugin from '../main';

export function registerCommands(plugin: HavemindPlugin): void {
  plugin.addCommand({
    id: 'open-activity',
    name: 'Open activity',
    callback: () => plugin.openPane(),
  });
  plugin.addCommand({
    id: 'connect',
    name: 'Connect to Havemind',
    callback: () => {
      plugin.invitations.connectionActive = false;
      plugin.views.refreshOnboardingNow();
      return plugin.openPane();
    },
  });
  // Single owner entry point: create the invitation and approve the joining
  // device in one living panel (replaces the old create/approve split).
  plugin.addCommand({
    id: 'create-connection',
    name: 'Create connection (owner)',
    callback: () => plugin.invitations.openCreateConnectionView(),
  });
  // The three connection actions the panel exposes as buttons also belong in
  // the palette, so they can be run, and bound to a hotkey, without hunting
  // for the pane. `checkCallback` reports availability: syncing and
  // disconnecting are meaningless with nothing connected, so they grey out
  // rather than fail on invocation.
  const actions = plugin.connectionActions();
  plugin.addCommand({
    id: 'sync-now',
    name: 'Sync now',
    checkCallback: (checking) => {
      if (checking) return actions.connected();
      actions.syncNow();
      return true;
    },
  });
  plugin.addCommand({
    id: 'disconnect',
    name: 'Disconnect',
    checkCallback: (checking) => {
      if (checking) return actions.connected();
      actions.disconnect();
      return true;
    },
  });
  // Reset carries no availability guard on purpose: it exists for the state in
  // which the stored pairing is damaged, and that state is not always
  // detectable up front, a user who needs it must always be able to reach it.
  plugin.addCommand({
    id: 'reset-connection',
    name: 'Reset connection',
    callback: () => {
      actions.resetConnection();
    },
  });
  // One hexagon, one pane (plans/007 Stage 0). The plugin used to offer three
  // doors, this icon for the activity feed, a second icon for the author
  // overlay, and the command palette for the panel that actually connects a
  // vault. A new user found the hexagon, got an activity list, and had no
  // route to connecting anything.
  plugin.addRibbonIcon('hexagon', 'Open Havemind', () => {
    void plugin.openPane();
  });
}

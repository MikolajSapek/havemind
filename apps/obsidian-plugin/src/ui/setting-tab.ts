/**
 * The Havemind settings tab. It answers the four questions a settings pane is
 * opened for — which server, what state, when last synced, who is in the vault —
 * and offers every connection action in place, routing each button into the same
 * `connectionActions()` definition the command palette uses so the two surfaces
 * cannot drift. There are no editable options, so nothing here invents one.
 *
 * The plugin type is pulled in with `import type`, which TypeScript and esbuild
 * both erase: the tab is handed its plugin through the constructor exactly as
 * before, and no runtime import edge back to `main.ts` is created.
 */

import { PluginSettingTab, Setting, type App } from 'obsidian';

import type HavemindPlugin from '../main';

import type { HavemindSettingsInfo } from './settings-model';

/** "2 members" / "1 member" / an honest empty state. */
export function formatMemberCount(count: number): string {
  if (count === 0) return 'No members recorded yet';
  return count === 1 ? '1 member' : `${count} members`;
}

export class HavemindSettingTab extends PluginSettingTab {
  /**
   * This tab's own plugin, typed. `PluginSettingTab.plugin` is declared as the
   * base `Plugin`, so keeping a narrowed field is what lets `display()` read the
   * Havemind surface directly instead of casting through `unknown` every time.
   */
  private readonly havemind: HavemindPlugin;

  constructor(app: App, plugin: HavemindPlugin) {
    super(app, plugin);
    this.havemind = plugin;
  }

  override display(): void {
    this.containerEl.empty();

    // FINDING 7: the tab used to be a dead end — one status line and a button
    // that sent the user somewhere else. It now answers the four questions a
    // settings pane is opened for (which server, what state, when last synced,
    // who is in the vault) and offers every connection action in place. There
    // are still no editable options, so nothing here invents one.
    const plugin = this.havemind;
    const info = plugin.settingsInfo();

    new Setting(this.containerEl).setName('Havemind').setHeading();
    new Setting(this.containerEl).setName('Server').setDesc(info.server);
    new Setting(this.containerEl).setName('Connection').setDesc(info.status);
    new Setting(this.containerEl).setName('Last sync').setDesc(info.lastSync);
    new Setting(this.containerEl)
      .setName('Vault members')
      .setDesc(info.members);

    new Setting(this.containerEl).setName('Actions').setHeading();
    this.renderActions(plugin, info);

    // FINDING 4: the settings tab reads the connection status once at display()
    // time, so a status change while the tab stays open leaves the line stale.
    // A subscribe/unsubscribe hook would need a `hide()` override the ambient
    // Obsidian typings and test mock do not expose; the cheaper honest fix is a
    // Refresh control that re-reads the live status on demand by re-rendering.
    const refresh = this.containerEl.createEl('button', { text: 'Refresh' });
    refresh.onClickEvent(() => this.display());
  }

  /**
   * The action rows. Every button routes into the SAME plugin method its command
   * palette entry runs — `connectionActions()` is the single definition of what
   * each action does, so the two surfaces can never drift apart.
   */
  private renderActions(
    plugin: HavemindPlugin,
    info: HavemindSettingsInfo,
  ): void {
    const actions = plugin.connectionActions();

    new Setting(this.containerEl)
      .setName('Havemind panel')
      .setDesc(
        'Connect a device, invite a peer, resolve conflicts and inspect the send queue.',
      )
      .addButton((button) =>
        button
          .setButtonText('Open Havemind panel')
          .setCta()
          .onClick(() => plugin.revealPanel()),
      );

    new Setting(this.containerEl)
      .setName('Sync now')
      .setDesc('Force a fresh sync cycle instead of waiting for the next poll.')
      .addButton((button) =>
        button
          .setButtonText('Sync now')
          .setDisabled(!info.connected)
          .onClick(() => actions.syncNow()),
      );

    new Setting(this.containerEl)
      .setName('Disconnect')
      .setDesc('Stop syncing. Notes on disk are left exactly as they are.')
      .addButton((button) =>
        button
          .setButtonText('Disconnect')
          .setDisabled(!info.connected)
          .onClick(() => actions.disconnect()),
      );

    new Setting(this.containerEl)
      .setName('Reset connection')
      .setDesc(
        'Clear the stored pairing so this device can be paired again. No note is touched.',
      )
      .addButton((button) =>
        button
          .setButtonText('Reset connection')
          .onClick(() => actions.resetConnection()),
      );

    const overlayOn = plugin.authorOverlayEnabled();
    new Setting(this.containerEl)
      .setName('Author overlay')
      .setDesc(
        overlayOn
          ? 'Currently on. Each note shows who last changed it, by colour and by name.'
          : 'Currently off. Author colours and names are hidden in both editor views.',
      )
      .addButton((button) =>
        button
          .setButtonText(overlayOn ? 'Hide authors' : 'Show authors')
          .onClick(() => {
            plugin.toggleAuthorOverlay();
            this.display();
          }),
      );
  }
}

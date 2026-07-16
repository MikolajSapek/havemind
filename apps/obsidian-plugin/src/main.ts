import {
  ItemView,
  Plugin,
  PluginSettingTab,
  Setting,
  type WorkspaceLeaf,
} from 'obsidian';

import { isSafePassiveJoinProtocolData } from './onboarding/invite';

export const HAVEMIND_ACTIVITY_VIEW = 'havemind-activity';
export const HAVEMIND_ONBOARDING_VIEW = 'havemind-onboarding';

class HavemindActivityView extends ItemView {
  override getDisplayText(): string {
    return 'Havemind activity';
  }

  override getIcon(): string {
    return 'users-round';
  }

  override getViewType(): string {
    return HAVEMIND_ACTIVITY_VIEW;
  }

  override onOpen(): void {
    const content = this.containerEl.children[1] as HTMLElement | undefined;
    if (!content) return;

    content.empty();
    content.createEl('h3', { text: 'Havemind activity' });
    content.createDiv({
      text: 'Connect a disposable vault to begin the private pilot.',
    });
  }
}

class HavemindOnboardingView extends ItemView {
  override getDisplayText(): string {
    return 'Connect to Havemind';
  }

  override getIcon(): string {
    return 'link';
  }

  override getViewType(): string {
    return HAVEMIND_ONBOARDING_VIEW;
  }

  override onOpen(): void {
    const content = this.containerEl.children[1] as HTMLElement | undefined;
    if (!content) return;

    content.empty();
    content.createEl('h3', { text: 'Connect to Havemind' });
    content.createDiv({
      text: 'Paste the secure invitation copied from the HTTPS join page.',
    });
  }
}

class HavemindSettingTab extends PluginSettingTab {
  override display(): void {
    this.containerEl.empty();

    new Setting(this.containerEl).setName('Havemind').setHeading();
    new Setting(this.containerEl)
      .setName('Connection')
      .setDesc('Not connected. Onboarding will be added in the next slice.');
  }
}

export default class HavemindPlugin extends Plugin {
  override onload(): void {
    this.registerView(
      HAVEMIND_ACTIVITY_VIEW,
      (leaf: WorkspaceLeaf) => new HavemindActivityView(leaf),
    );
    this.registerView(
      HAVEMIND_ONBOARDING_VIEW,
      (leaf: WorkspaceLeaf) => new HavemindOnboardingView(leaf),
    );

    this.addCommand({
      id: 'open-activity',
      name: 'Open activity',
      callback: () => this.openActivityView(),
    });

    this.addRibbonIcon('users-round', 'Open Havemind activity', () => {
      void this.openActivityView();
    });

    const status = this.addStatusBarItem();
    status.setText('Havemind: disconnected');

    this.addSettingTab(new HavemindSettingTab(this.app, this));

    this.registerEditorExtension([]);
    this.registerMarkdownPostProcessor(() => undefined);
    this.registerObsidianProtocolHandler('havemind-join', (data) => {
      // The secret invitation is never accepted from the URI query. Only the
      // parameter-free passive URI opens the local paste wizard; any query
      // field (token, envelope, secret, or otherwise) is refused.
      if (!isSafePassiveJoinProtocolData(data)) return;
      void this.openView(HAVEMIND_ONBOARDING_VIEW);
    });
  }

  override onunload(): void {
    this.app.workspace.detachLeavesOfType(HAVEMIND_ACTIVITY_VIEW);
    this.app.workspace.detachLeavesOfType(HAVEMIND_ONBOARDING_VIEW);
  }

  private openActivityView(): Promise<void> {
    return this.openView(HAVEMIND_ACTIVITY_VIEW);
  }

  private async openView(type: string): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(type)[0];
    const leaf = existingLeaf ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    if (!existingLeaf) {
      await leaf.setViewState({
        active: true,
        type,
      });
    }

    await this.app.workspace.revealLeaf(leaf);
  }
}

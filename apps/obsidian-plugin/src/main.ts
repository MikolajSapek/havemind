import {
  ItemView,
  Plugin,
  PluginSettingTab,
  Setting,
  type WorkspaceLeaf,
} from 'obsidian';

export const HAVEMIND_ACTIVITY_VIEW = 'havemind-activity';

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
    this.registerObsidianProtocolHandler('havemind-join', () => undefined);
  }

  override onunload(): void {
    this.app.workspace.detachLeavesOfType(HAVEMIND_ACTIVITY_VIEW);
  }

  private async openActivityView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(
      HAVEMIND_ACTIVITY_VIEW,
    )[0];
    const leaf = existingLeaf ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;

    if (!existingLeaf) {
      await leaf.setViewState({
        active: true,
        type: HAVEMIND_ACTIVITY_VIEW,
      });
    }

    await this.app.workspace.revealLeaf(leaf);
  }
}

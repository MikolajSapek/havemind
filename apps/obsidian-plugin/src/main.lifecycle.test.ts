import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin, { HAVEMIND_ACTIVITY_VIEW } from './main';
// F3-01: remove the @ts-expect-error once main.ts exports HAVEMIND_ONBOARDING_VIEW
// (it then becomes an unused-directive error, forcing this cleanup and merging the imports).
// @ts-expect-error -- HAVEMIND_ONBOARDING_VIEW ships with the F3-01 onboarding view
import { HAVEMIND_ONBOARDING_VIEW } from './main';
import {
  App,
  type MockElement,
  registrationState,
  resetObsidianMock,
  type PluginManifest,
  WorkspaceLeaf,
} from './test/obsidian.mock';

const manifest: PluginManifest = {
  author: 'Mikolaj Pawel Sapek',
  description: 'Synchronize shared Markdown vaults with durable history.',
  id: 'havemind-sync',
  isDesktopOnly: true,
  minAppVersion: '1.11.4',
  name: 'Havemind',
  version: '0.0.1',
};

describe('plugin lifecycle', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  // F3-01: un-skip when the onboarding view is registered by main.ts
  it.skip('registers the complete passive desktop shell without scanning or networking', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);

    await plugin.onload();

    expect(registrationState.settingsTabs).toHaveLength(1);
    expect(registrationState.ribbons).toHaveLength(1);
    expect(registrationState.statusItems).toHaveLength(1);
    expect(registrationState.views.has(HAVEMIND_ACTIVITY_VIEW)).toBe(true);
    expect(registrationState.views.has(HAVEMIND_ONBOARDING_VIEW)).toBe(true);
    expect(registrationState.editorExtensions).toHaveLength(1);
    expect(registrationState.markdownPostProcessors).toHaveLength(1);
    expect(registrationState.protocolHandlers.has('havemind-join')).toBe(true);
    expect(registrationState.commands.map(({ id }) => id)).toEqual([
      'open-activity',
    ]);
    expect(app.vault.getMarkdownFilesCalls).toBe(0);
    expect(app.network.requestCalls).toBe(0);
  });

  it('opens the registered Activity view from the command', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const command = registrationState.commands[0];
    expect(command).toBeDefined();
    await command?.callback();

    expect(app.workspace.rightLeaf?.states).toEqual([
      { active: true, type: HAVEMIND_ACTIVITY_VIEW },
    ]);
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);
  });

  it('reuses an existing Activity leaf and handles an unavailable sidebar', async () => {
    const app = new App();
    const existingLeaf = new WorkspaceLeaf();
    app.workspace.leaves.set(HAVEMIND_ACTIVITY_VIEW, [existingLeaf]);
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const command = registrationState.commands[0];
    await command?.callback();

    expect(existingLeaf.states).toEqual([]);
    expect(app.workspace.revealedLeaves).toEqual([existingLeaf]);

    app.workspace.leaves.clear();
    app.workspace.rightLeaf = null;
    await command?.callback();
    expect(app.workspace.revealedLeaves).toEqual([existingLeaf]);
  });

  it('opens Activity from the ribbon and renders passive view and settings content', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    await registrationState.ribbons[0]?.triggerClick();
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);

    const creator = registrationState.views.get(HAVEMIND_ACTIVITY_VIEW);
    expect(creator).toBeDefined();
    const view = creator?.(new WorkspaceLeaf());
    expect(view?.getViewType()).toBe(HAVEMIND_ACTIVITY_VIEW);
    expect(view?.getDisplayText()).toBe('Havemind activity');
    expect(view?.getIcon()).toBe('users-round');

    await view?.onOpen();
    const container = view?.containerEl as unknown as MockElement;
    expect(container.children[1]?.children.map(({ text }) => text)).toEqual([
      'Havemind activity',
      'Connect a disposable vault to begin the private pilot.',
    ]);

    registrationState.settingsTabs[0]?.display();
    expect(registrationState.settingsRows.map(({ names }) => names)).toEqual([
      ['Havemind'],
      ['Connection'],
    ]);

    registrationState.markdownPostProcessors[0]?.(
      container as unknown as HTMLElement,
      {},
    );
    registrationState.protocolHandlers.get('havemind-join')?.({
      action: 'havemind-join',
    });
  });

  it('does not assume that an Activity content element is available', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const view = registrationState.views
      .get(HAVEMIND_ACTIVITY_VIEW)
      ?.(new WorkspaceLeaf());
    const container = view?.containerEl as unknown as MockElement;
    container.children.splice(0);

    expect(view?.onOpen()).toBeUndefined();
  });

  // F3-01: un-skip when the onboarding view is registered by main.ts
  it.skip('opens only the local paste wizard from a parameter-free passive URI', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();
    const handler = registrationState.protocolHandlers.get('havemind-join');

    await handler?.({ action: 'havemind-join' });

    expect(app.workspace.rightLeaf?.states).toEqual([
      { active: true, type: HAVEMIND_ONBOARDING_VIEW },
    ]);
    expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);
    expect(app.network.requestCalls).toBe(0);

    const creator = registrationState.views.get(HAVEMIND_ONBOARDING_VIEW);
    const view = creator?.(new WorkspaceLeaf());
    await view?.onOpen();
    const container = view?.containerEl as unknown as MockElement;
    expect(container.children[1]?.children.map(({ text }) => text)).toEqual([
      'Connect to Havemind',
      'Paste the secure invitation copied from the HTTPS join page.',
    ]);
  });

  it.each(['token', 'envelope', 'secret', 'harmless']) (
    'rejects the %s query field without opening a view or starting network access',
    async (field) => {
      const app = new App();
      const plugin = new HavemindPlugin(app, manifest);
      await plugin.onload();
      const handler = registrationState.protocolHandlers.get('havemind-join');

      await handler?.({
        action: 'havemind-join',
        [field]: 'must-not-be-accepted',
      });

      expect(app.workspace.rightLeaf?.states).toEqual([]);
      expect(app.workspace.revealedLeaves).toEqual([]);
      expect(app.network.requestCalls).toBe(0);
    },
  );

  // F3-01: un-skip when the onboarding view is registered by main.ts
  it.skip('removes registered resources and detached views during unload', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const ribbon = registrationState.ribbons[0];
    const status = registrationState.statusItems[0];
    plugin.unload();

    expect(app.workspace.detachedTypes).toEqual([
      HAVEMIND_ACTIVITY_VIEW,
      HAVEMIND_ONBOARDING_VIEW,
    ]);
    expect(ribbon?.removed).toBe(true);
    expect(status?.removed).toBe(true);
    expect(registrationState.settingsTabs).toHaveLength(0);
    expect(registrationState.views).toHaveLength(0);
    expect(registrationState.editorExtensions).toHaveLength(0);
    expect(registrationState.markdownPostProcessors).toHaveLength(0);
    expect(registrationState.protocolHandlers).toHaveLength(0);
    expect(registrationState.commands).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin from './main';
import {
  App,
  type MockElement,
  type PluginManifest,
  registrationState,
  resetObsidianMock,
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

function flatten(element: MockElement): MockElement[] {
  return element.children.flatMap((child) => [child, ...flatten(child)]);
}

/** The description the "Connection" setting row currently shows. */
function connectionDesc(): string | undefined {
  const row = registrationState.settingsRows.find((r) =>
    r.names.includes('Connection'),
  );
  return row?.descriptions[0];
}

describe('HavemindSettingTab refresh affordance (FINDING 4)', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('re-renders the live connection status on demand while the tab is open', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const tab = registrationState.settingsTabs[0];
    if (tab === undefined) throw new Error('settings tab was not registered');

    registrationState.settingsRows.splice(0);
    tab.display();
    expect(connectionDesc()).toBe(plugin.panelStatusLabel());

    // A status change while the tab stays open would otherwise leave the label
    // stale; the Refresh control must re-read it.
    (plugin as unknown as { connectionStatus: string }).connectionStatus =
      'synced';
    const staleLabel = connectionDesc();

    const refresh = flatten(tab.containerEl as unknown as MockElement).find(
      (e) => e.text === 'Refresh',
    );
    expect(refresh).toBeDefined();

    registrationState.settingsRows.splice(0);
    refresh?.triggerClick();

    expect(connectionDesc()).toBe(plugin.panelStatusLabel());
    expect(connectionDesc()).not.toBe(staleLabel);
  });
});

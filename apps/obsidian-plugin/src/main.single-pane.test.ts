/**
 * One hexagon, one pane (plans/007 Stage 0).
 *
 * The plugin shipped three doors into one product: the ribbon hexagon opened
 * the activity feed, a second ribbon icon toggled the author overlay, and the
 * panel that actually connects a vault was reachable only from the command
 * palette. A new user clicked the hexagon, got an activity list, and had no
 * path to connecting anything.
 *
 * These tests pin the collapse to a single ribbon icon and a single registered
 * view, and, just as importantly, that collapsing it did not take the keyboard
 * and screen-reader path down with it (F8-02d).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin from './main';
import {
  App,
  type PluginManifest,
  registrationState,
  resetObsidianMock,
} from './test/obsidian.mock';
import { HAVEMIND_ONBOARDING_VIEW } from './ui/view-types';

const manifest: PluginManifest = {
  author: 'Mikolaj Pawel Sapek',
  description: 'Synchronize shared Markdown vaults with durable history.',
  id: 'havemind-sync',
  isDesktopOnly: true,
  minAppVersion: '1.11.4',
  name: 'Havemind',
  version: '0.0.1',
};

function newPlugin(): HavemindPlugin {
  const plugin = new HavemindPlugin(new App(), manifest);
  let disk: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).loadData = async () => disk;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).saveData = async (data: unknown) => {
    disk = data as Record<string, unknown>;
  };
  return plugin;
}

describe('single pane', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('registers exactly one ribbon icon', async () => {
    const plugin = newPlugin();
    await plugin.onload();

    expect(registrationState.ribbons).toHaveLength(1);
  });

  it('gives that icon the hexagon mark', async () => {
    const plugin = newPlugin();
    await plugin.onload();

    expect(registrationState.ribbons[0]?.iconName).toBe('hexagon');
  });

  it('sends every entry point to the same pane', async () => {
    // The goal is one destination, not one registered class. The legacy
    // activity view stays registered so a leaf someone already has open keeps
    // resolving after the upgrade, but nothing routes users there any more.
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    await registrationState.ribbons[0]?.triggerClick();
    const fromRibbon = app.workspace.rightLeaf?.states.at(-1)?.type;

    const openActivity = registrationState.commands.find(
      (entry) => entry.id === 'open-activity',
    );
    await openActivity?.callback?.();
    const fromCommand = app.workspace.rightLeaf?.states.at(-1)?.type;

    expect(fromRibbon).toBe(HAVEMIND_ONBOARDING_VIEW);
    expect(fromCommand).toBe(HAVEMIND_ONBOARDING_VIEW);
  });

  it('keeps every command registered, so the keyboard path survives', async () => {
    // AT0-4: removing a ribbon icon must not remove a keyboard or
    // screen-reader route to the same action (regression on F8-02d).
    const plugin = newPlugin();
    await plugin.onload();

    // Command ids are a public contract: a user may have bound a hotkey to one,
    // so collapsing the ribbon must not rename them.
    const ids = registrationState.commands.map((entry) => entry.id);
    for (const id of [
      'open-activity',
      'connect',
      'create-connection',
      'sync-now',
      'disconnect',
      'reset-connection',
      'show-authors',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('exposes the author overlay as a command, not only a ribbon icon', async () => {
    // The overlay toggle loses its ribbon icon and becomes a control inside the
    // pane; the command is what keeps it reachable without a mouse.
    const plugin = newPlugin();
    await plugin.onload();

    const toggle = registrationState.commands.find(
      (entry) => entry.id === 'show-authors',
    );
    expect(toggle).toBeDefined();
    expect(toggle?.name).toMatch(/author/i);
  });
});

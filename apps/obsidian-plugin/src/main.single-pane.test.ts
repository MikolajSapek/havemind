/**
 * UI-00 / plans/007 Stage 0: one hexagon, one pane.
 *
 * Three doors used to open Havemind (a ribbon hexagon to Activity, a second
 * ribbon icon toggling the author overlay, and the command palette to the
 * connect panel). Stages 0 and 1 already collapsed the ribbon to one icon and
 * pointed every command at the single pane; what survived was the SECOND
 * REGISTERED VIEW TYPE. `HAVEMIND_ACTIVITY_VIEW` stayed registered with nothing
 * left to open it, so a workspace layout saved while the old Activity leaf was
 * open could still restore a second, orphaned Havemind surface that no command
 * reaches and that drifts from the pane's own Activity tab.
 *
 * AT0-1..AT0-4 from `plans/007-ui-rebuild.md`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin, {
  HAVEMIND_ACTIVITY_VIEW,
  HAVEMIND_ONBOARDING_VIEW,
} from './main';
import {
  App,
  registrationState,
  resetObsidianMock,
  type PluginManifest,
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

describe('one hexagon, one pane (UI-00)', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('AT0-1: registers exactly one ribbon icon, and it opens the pane', async () => {
    const plugin = new HavemindPlugin(new App(), manifest);
    await plugin.onload();

    expect(registrationState.ribbons).toHaveLength(1);
    // The mock records the Lucide name, which is how the pane's own mark is
    // drawn; a second ribbon action would show up as a second entry here.
    expect(registrationState.ribbons[0]?.iconName).toBe('hexagon');
  });

  it('AT0-2: registers exactly one view type', async () => {
    const plugin = new HavemindPlugin(new App(), manifest);
    await plugin.onload();

    expect([...registrationState.views.keys()]).toEqual([
      HAVEMIND_ONBOARDING_VIEW,
    ]);
    // The old Activity type must not merely be unused: while it stays
    // registered, a restored workspace layout can still rebuild that leaf.
    expect(registrationState.views.has(HAVEMIND_ACTIVITY_VIEW)).toBe(false);
  });

  it('AT0-4: every command still resolves after the icon count drops', async () => {
    // Negative AC, regression on F8-02d. The palette and hotkeys are the
    // keyboard and screen-reader route; collapsing the visual doors must not
    // remove a single one of them.
    const plugin = new HavemindPlugin(new App(), manifest);
    await plugin.onload();

    const ids = registrationState.commands.map((command) => command.id);
    for (const id of [
      'open-activity',
      'connect',
      'show-authors',
      'sync-now',
    ]) {
      expect(ids, `command ${id} must survive Stage 0`).toContain(id);
    }
    // Each one is invocable, not merely present. A command carries either a
    // plain callback or a checkCallback; both are keyboard routes.
    for (const command of registrationState.commands) {
      const invocable =
        typeof command.callback === 'function' ||
        typeof command.checkCallback === 'function';
      expect(invocable, `command ${command.id} has no callback`).toBe(true);
    }
  });
});

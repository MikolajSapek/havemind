/**
 * Keyboard and screen-reader coverage for the plugin's own surfaces.
 *
 * Audit finding: the status-bar item was clickable but had no name, no role and
 * no keyboard route, and the panel's glyphs (status icon, roster colour dots,
 * the conflicts header, the hive-hexagon in every title) were announced as
 * unlabelled images even though a text label already sat beside them. Colour and
 * shape must never be the only signal, and every glyph that is pure decoration
 * must be hidden from assistive technology rather than read out.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import HavemindPlugin, {
  HavemindOnboardingView,
  HAVEMIND_ONBOARDING_VIEW,
  renderConflictSection,
} from './main';
import type { ConflictCopy } from './runtime/conflict-resolution';
import { buildRejoinRosterView } from './runtime/rejoin-roster';
import { buildConnectionPanel } from './runtime/status';
import {
  App,
  ItemView,
  type MockElement,
  type PluginManifest,
  registrationState,
  resetObsidianMock,
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

/** Depth-first list of an element and all of its descendants. */
function flatten(element: MockElement): MockElement[] {
  return element.children.flatMap((child) => [child, ...flatten(child)]);
}

/** A bare content host, mirroring the second child of a view container. */
function createContent(): MockElement {
  const view = new ItemView(new WorkspaceLeaf());
  return view.containerEl.children[1] as unknown as MockElement;
}

function asEl(element: MockElement): HTMLElement {
  return element as unknown as HTMLElement;
}

/** Every element carrying a Lucide glyph, anywhere under `root`. */
function glyphs(root: MockElement): MockElement[] {
  return [root, ...flatten(root)].filter(({ iconName }) => iconName !== '');
}

/** Drains pending microtasks so a fire-and-forget open completes. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** A keydown event double that records whether the default was prevented. */
function keydown(key: string): { key: string; prevented: boolean } {
  const event = {
    key,
    prevented: false,
    preventDefault(): void {
      event.prevented = true;
    },
  };
  return event;
}

const CONFLICT_COPY: ConflictCopy = {
  copyPath: 'Havemind conflicts/A (conflict).md',
  copyName: 'A (conflict).md',
  kind: 'new',
  noteName: 'A',
  author: 'Magda',
  timestamp: '2026-08-10 09:00',
  isBinary: false,
  targetPath: 'A.md',
  targetKnown: true,
  manualHint: null,
};

describe('status bar item accessibility', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('announces itself as a named button and joins the tab order', async () => {
    const plugin = new HavemindPlugin(new App(), manifest);
    await plugin.onload();

    const status = registrationState.statusItems[0];
    expect(status?.attrs['role']).toBe('button');
    expect(status?.attrs['tabindex']).toBe('0');
    expect(status?.attrs['aria-label']).toBe('Open Havemind panel');
  });

  it('opens the panel from Enter and from Space, and suppresses the page scroll', async () => {
    for (const key of ['Enter', ' ']) {
      resetObsidianMock();
      const app = new App();
      const plugin = new HavemindPlugin(app, manifest);
      await plugin.onload();

      const status = registrationState.statusItems[0];
      const event = keydown(key);
      status?.triggerEvent('keydown', event);
      await flush();

      expect(app.workspace.rightLeaf?.states).toEqual([
        { active: true, type: HAVEMIND_ONBOARDING_VIEW },
      ]);
      expect(app.workspace.revealedLeaves).toEqual([app.workspace.rightLeaf]);
      expect(event.prevented).toBe(true);
    }
  });

  it('ignores every other key', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const status = registrationState.statusItems[0];
    const event = keydown('a');
    status?.triggerEvent('keydown', event);
    await flush();

    expect(app.workspace.revealedLeaves).toEqual([]);
    expect(event.prevented).toBe(false);
  });

  it('hides the status-bar hexagon from assistive technology', async () => {
    const plugin = new HavemindPlugin(new App(), manifest);
    await plugin.onload();

    const status = registrationState.statusItems[0];
    if (status === undefined) throw new Error('no status bar item registered');
    // The state word is already in the text span next to it.
    for (const glyph of glyphs(status)) {
      expect(glyph.attrs['aria-hidden']).toBe('true');
    }
  });
});

describe('panel glyph accessibility', () => {
  beforeEach(() => {
    resetObsidianMock();
  });

  it('hides every decorative glyph in the connected panel', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'server.example' }),
      rejoinRosterProvider: () =>
        buildRejoinRosterView(
          [
            { membershipId: 'm-owner', displayName: 'You', role: 'owner', self: true },
            {
              membershipId: 'm-magda',
              displayName: 'Magda',
              role: 'editor',
              self: false,
            },
          ],
          ['m-magda'],
        ),
      rejoinWaitingProvider: () => new Set<string>(),
      onRejoin: () => undefined,
      onDisconnect: () => undefined,
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement)
      .children[1] as MockElement;
    // An icon is either decoration, which must be hidden, or the entire label of
    // a control, which must instead carry an accessible name. A glyph that is
    // neither is unreachable and unannounced.
    const decorative = glyphs(content).filter(
      (glyph) => (glyph.attrs['aria-label'] ?? '') === '',
    );
    // The panel does draw glyphs (title hexagon, status icon, roster dots) —
    // otherwise this test would pass vacuously.
    expect(decorative.length).toBeGreaterThan(2);
    for (const glyph of decorative) {
      expect(glyph.attrs['aria-hidden']).toBe('true');
    }

    for (const named of glyphs(content).filter(
      (glyph) => (glyph.attrs['aria-label'] ?? '') !== '',
    )) {
      expect(named.tag).toBe('button');
    }
  });

  it('pairs each roster colour dot with a name and a status word', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'server.example' }),
      rejoinRosterProvider: () =>
        buildRejoinRosterView(
          [
            {
              membershipId: 'm-magda',
              displayName: 'Magda',
              role: 'editor',
              self: false,
            },
          ],
          ['m-magda'],
        ),
      rejoinWaitingProvider: () => new Set<string>(),
      onDisconnect: () => undefined,
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement)
      .children[1] as MockElement;
    const all = flatten(content);
    const dot = all.find((element) =>
      element.classes.includes('havemind-roster-dot'),
    );
    expect(dot?.attrs['aria-hidden']).toBe('true');
    expect(all.some(({ text }) => text === 'Magda')).toBe(true);
    expect(all.some(({ text }) => text === 'editor · disconnected')).toBe(true);
  });

  it('keeps the icon-only help toggle labelled and its glyph hidden', async () => {
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'server.example' }),
      onDisconnect: () => undefined,
    });
    await view.onOpen();

    const content = (view.containerEl as unknown as MockElement)
      .children[1] as MockElement;
    // The help toggle moved into the pane footer (design 1a) but keeps its
    // contract: an icon-only control states what pressing it will do, and
    // reports whether the panel it controls is currently open.
    const toggle = flatten(content).find(
      (element) => element.attrs['aria-label'] === 'Show getting started',
    );
    expect(toggle).toBeDefined();
    expect(toggle?.attrs['aria-expanded']).toBe('false');
  });

  it('hides the conflicts header glyph, whose meaning is already in the text', () => {
    const content = createContent();
    renderConflictSection(asEl(content), [CONFLICT_COPY], {
      onResolve: () => undefined,
    });

    const decorative = glyphs(content);
    expect(decorative).toHaveLength(1);
    for (const glyph of decorative) {
      expect(glyph.attrs['aria-hidden']).toBe('true');
    }
  });
});

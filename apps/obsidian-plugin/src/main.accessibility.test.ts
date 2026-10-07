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

import HavemindPlugin from './main';
import { renderConflictSection } from './ui/conflict-section';
import { HavemindOnboardingView } from './ui/onboarding-view';
import { HAVEMIND_ONBOARDING_VIEW } from './ui/view-types';
import type { ConflictCopy } from './runtime/conflict-resolution';
import { buildRejoinRosterView } from './runtime/rejoin-roster';
import { buildConnectionPanel, formatStatusBar } from './runtime/status';
import {
  App,
  type MockElement,
  registrationState,
  resetObsidianMock,
  WorkspaceLeaf,
} from './test/obsidian.mock';
import { descendants, createContent, asEl } from './test/dom';
import { manifest, flush } from './test/fixtures';

/** Every element carrying a Lucide glyph, anywhere under `root`. */
/** Opens a tab in the connected pane (one sidebar, tabs to switch). */
function openTab(view: { containerEl: unknown }, label: RegExp): void {
  const root = view.containerEl as unknown as MockElement;
  const tab = descendants(root).find(
    (el) => el.attrs['role'] === 'tab' && label.test(el.attrs['aria-label'] ?? ''),
  );
  if (tab === undefined) throw new Error(`tab ${label} not rendered`);
  tab.triggerClick();
}

function glyphs(root: MockElement): MockElement[] {
  return [root, ...descendants(root)].filter(({ iconName }) => iconName !== '');
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

  it('draws its state as a hexagon the stylesheet styles, next to the words', async () => {
    const plugin = new HavemindPlugin(new App(), manifest);
    await plugin.onload();

    const status = registrationState.statusItems[0];
    const glyph = status?.children[0];
    expect(glyph?.attrs['aria-hidden']).toBe('true');
    const svg = glyph?.children[0];
    expect(svg?.tag).toBe('svg');
    expect(svg?.classes).toContain('havemind-status-glyph');
    expect(svg?.classes).toContain('is-disconnected');
    expect(status?.children[1]?.text).toBe('Havemind: Disconnected');

    // A new state changes the class and the words, never the element: a
    // rebuilt glyph would restart its animation on every repaint.
    plugin.statusBar.setStatus(formatStatusBar({ status: 'offline' }));
    expect(status?.children[0]?.children[0]).toBe(svg);
    expect(svg?.classes).toContain('is-offline');
    expect(svg?.classes).not.toContain('is-disconnected');
    expect(status?.children[1]?.text).toBe('Havemind: Offline');
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

  it('removes its keyboard listener when the plugin unloads', async () => {
    const app = new App();
    const plugin = new HavemindPlugin(app, manifest);
    await plugin.onload();

    const status = registrationState.statusItems[0];
    plugin.unload();
    status?.triggerEvent('keydown', keydown('Enter'));
    await flush();

    expect(app.workspace.revealedLeaves).toEqual([]);
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
    // The one picture, the flower, is an image with a name rather than
    // decoration; the loop below still covers any glyph that is decoration.
    const flower = descendants(content).find((el) => el.classes.includes('havemind-flower'));
    expect(flower?.attrs['role']).toBe('img');
    expect(flower?.attrs['aria-label']).toMatch(/devices/);
    for (const glyph of decorative) {
      expect(glyph.attrs['aria-hidden']).toBe('true');
    }

    for (const named of glyphs(content).filter(
      (glyph) => (glyph.attrs['aria-label'] ?? '') !== '',
    )) {
      expect(named.tag).toBe('button');
    }
  });

  it('pairs each roster colour dot with a name and a role', async () => {
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
        ),
      rejoinWaitingProvider: () => new Set<string>(),
      onDisconnect: () => undefined,
    });
    await view.onOpen();
    openTab(view, /People/);

    const content = (view.containerEl as unknown as MockElement)
      .children[1] as MockElement;
    const all = descendants(content);
    // No colour dot to hide any more (plan 010): the name and role are the row.
    expect(all.some((element) => element.classes.includes('havemind-roster-dot'))).toBe(false);
    expect(all.some(({ text }) => text === 'Magda')).toBe(true);
    expect(all.some(({ text }) => text === 'Editor')).toBe(true);
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
    // Getting started lives in the native More options menu: read once and
    // then never again is exactly what an overflow menu is for. It must still
    // be reachable, and its label must state what pressing it will do.
    const more = descendants(content).find(
      (element) => element.attrs['aria-label'] === 'More options',
    );
    expect(more).toBeDefined();
    more?.triggerClick();

    const entry = registrationState.menus
      .at(-1)
      ?.items.find(({ title }) => /show getting started/i.test(title));
    expect(entry).toBeDefined();
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

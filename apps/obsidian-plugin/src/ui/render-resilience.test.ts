/**
 * A throwing provider costs its own section, never the pane.
 *
 * The view's own docstring promises that "every section renders inside its own
 * error boundary so one failing provider can never blank the pane". That was
 * true of the sections wrapped in `renderSection`, and false of everything
 * read before them: the shell reads `guestInvalidProvider`, `guestWaitingProvider`,
 * `panelProvider`, `authorOverlayProvider` and `composerProvider` outside any
 * boundary, and `render()` has already called `content.empty()` by then.
 *
 * So a throw from any of those left an empty pane, no header, no tabs, no way
 * back, which is the exact failure the boundaries exist to prevent, arriving
 * through the one path nothing guarded.
 *
 * These tests hold every provider to the same contract: the pane still renders,
 * and the user can still reach the rest of it.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { buildConnectionPanel } from '../runtime/status';
import { WorkspaceLeaf, type MockElement } from '../test/obsidian.mock';

import {
  HavemindOnboardingView,
  type OnboardingViewOptions,
} from './onboarding-view';

function flatten(el: MockElement): MockElement[] {
  return [el, ...(el.children ?? []).flatMap(flatten)];
}

function pane(options: OnboardingViewOptions): MockElement {
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), options);
  view.onOpen();
  return view.containerEl as unknown as MockElement;
}

const boom = (): never => {
  throw new Error('provider exploded');
};

/** A pane that is connected and has every surface populated. */
const HEALTHY: OnboardingViewOptions = {
  panelProvider: () => buildConnectionPanel({ status: 'synced' }),
  authorOverlayProvider: () => false,
  onToggleAuthorOverlay: () => {},
  onOpenComposer: () => {},
  onSyncNow: () => {},
  onDisconnect: () => {},
};

beforeEach(() => {
  // The boundaries log on the way past; the test asserts behaviour, not noise.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the shell survives a throwing provider', () => {
  it.each([
    ['panelProvider', { panelProvider: boom }],
    ['guestWaitingProvider', { guestWaitingProvider: boom }],
    ['guestInvalidProvider', { guestInvalidProvider: boom }],
    ['authorOverlayProvider', { authorOverlayProvider: boom }],
    ['composerProvider', { composerProvider: boom }],
  ])('%s', (_name, override) => {
    const root = pane({ ...HEALTHY, ...override });
    const all = flatten(root);

    // The header is the pane's way back: it holds the overflow menu with
    // Disconnect and Reset. Losing it strands the user with no recovery.
    expect(
      all.some((el) => el.classes.includes('havemind-pane-header')),
      'the header must survive any provider failure',
    ).toBe(true);
    expect(all.length).toBeGreaterThan(3);
  });
});

describe('the tab body survives a throwing provider', () => {
  it.each([
    ['rejoinRosterProvider', { rejoinRosterProvider: boom }],
    ['activityFeedProvider', { activityFeedProvider: boom }],
    ['conflictsProvider', { conflictsProvider: boom, onResolveConflict: () => {} }],
    ['sendQueueProvider', { sendQueueProvider: boom }],
  ])('%s keeps the tabs reachable', (_name, override) => {
    const root = pane({ ...HEALTHY, ...override });
    const all = flatten(root);

    // The strip is how the user leaves a broken tab for a working one.
    const tabs = all.filter((el) => el.attrs['role'] === 'tab');
    expect(tabs).toHaveLength(4);
    expect(all.some((el) => el.classes.includes('havemind-pane-header'))).toBe(
      true,
    );
  });
});

describe('a failure is reported, not swallowed', () => {
  it('shows the section fallback where the broken list would have been', () => {
    // On the People tab, because that is where the roster renders, the same
    // provider throwing while Status is open costs nothing, which is the point
    // of scoping a boundary to a section rather than to the pane.
    const root = pane({
      ...HEALTHY,
      rejoinRosterProvider: boom,
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: null,
        pending: [],
      }),
    });

    expect(
      flatten(root).some((el) =>
        el.classes.includes('havemind-section-error'),
      ),
      'a failed section states that it failed',
    ).toBe(true);
  });
});

describe('providers are read once per render', () => {
  it('does not call the same provider repeatedly', () => {
    // Each read is a chance to disagree with the last: two calls to
    // `composerProvider` in one render can return different objects, so the
    // tab model and the tab body would then describe different states.
    let composerCalls = 0;
    let panelCalls = 0;

    pane({
      ...HEALTHY,
      panelProvider: () => {
        panelCalls += 1;
        return buildConnectionPanel({ status: 'synced' });
      },
      composerProvider: () => {
        composerCalls += 1;
        return null;
      },
    });

    expect(panelCalls).toBe(1);
    expect(composerCalls).toBe(1);
  });
});

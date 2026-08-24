/**
 * The activity feed as a section of the single pane (plans/007 Stage 0).
 *
 * The feed lives in memory and rebuilds from the log, so it is empty on every
 * fresh start. The first cut of this section returned early on an empty feed,
 * which meant a freshly-reloaded pane showed no Activity row at all — the user
 * could not tell whether the section had moved, broken, or simply had nothing
 * to say. An empty feed is a state to render, not a reason to disappear.
 */

import { describe, expect, it } from 'vitest';

import { buildConnectionPanel } from '../runtime/status';
import {
  WorkspaceLeaf,
  type MockElement,
} from '../test/obsidian.mock';

import {
  HavemindOnboardingView,
  type OnboardingViewOptions,
} from './onboarding-view';

function flatten(el: MockElement): MockElement[] {
  return [el, ...(el.children ?? []).flatMap(flatten)];
}

function connectedPane(options: OnboardingViewOptions = {}): MockElement {
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
    panelProvider: () => buildConnectionPanel({ status: 'synced' }),
    ...options,
  });
  void view.onOpen();
  return view.containerEl as unknown as MockElement;
}

/** Clicks a tab by its accessible name. */
function openTab(root: MockElement, label: RegExp): void {
  const tab = flatten(root).find(
    (el) => el.attrs['role'] === 'tab' && label.test(el.attrs['aria-label'] ?? ''),
  );
  if (tab === undefined) throw new Error(`tab ${label} not rendered`);
  tab.triggerClick();
}

describe('activity in the pane', () => {
  it('offers an Activity tab', () => {
    const root = connectedPane({ activityFeedProvider: () => [] });
    const labels = flatten(root)
      .filter((el) => el.attrs['role'] === 'tab')
      .map((el) => el.attrs['aria-label'] ?? '');

    expect(labels.some((l) => /activity/i.test(l))).toBe(true);
  });

  it('says why it is empty rather than showing a blank tab', () => {
    // The log is in-memory and rebuilds on every start, so "empty" is the
    // normal state right after a reload. A blank body would leave the user
    // unable to tell whether the feed broke or simply has nothing to report.
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () => buildConnectionPanel({ status: 'synced' }),
      activityFeedProvider: () => [],
    });
    void view.onOpen();
    const root = view.containerEl as unknown as MockElement;

    openTab(root, /activity/i);

    const texts = flatten(view.containerEl as unknown as MockElement).map(
      (el) => el.text,
    );
    expect(texts.some((t) => /no activity yet/i.test(t))).toBe(true);
  });

  it('lets a user leave the invitation composer through the other tabs', () => {
    // The header plus opens the composer in People, but composing an invite
    // must not turn the tab strip into a trap. Status remains useful while an
    // owner waits for a recipient and must stay reachable in one click.
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () => buildConnectionPanel({ status: 'synced' }),
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: null,
        pending: [],
      }),
    });
    void view.onOpen();

    openTab(view.containerEl as unknown as MockElement, /status/i);

    const root = view.containerEl as unknown as MockElement;
    const all = flatten(root);
    expect(all.some((el) => /connected.*synced/i.test(el.text))).toBe(true);
    expect(all.some((el) => el.text === 'Creating connection')).toBe(false);
  });
});

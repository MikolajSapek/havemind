/**
 * The activity feed as a section of the single pane (plans/007 Stage 0).
 *
 * The feed lives in memory and rebuilds from the log, so it is empty on every
 * fresh start. The first cut of this section returned early on an empty feed,
 * which meant a freshly-reloaded pane showed no Activity row at all, the user
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
});

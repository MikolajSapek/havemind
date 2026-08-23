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

import { HavemindOnboardingView } from './onboarding-view';
import { buildConnectionPanel } from '../runtime/status';
import {
  WorkspaceLeaf,
  type MockElement,
} from '../test/obsidian.mock';

function flatten(el: MockElement): MockElement[] {
  return [el, ...(el.children ?? []).flatMap(flatten)];
}

function connectedPane(
  options: Partial<Parameters<typeof HavemindOnboardingView.prototype.constructor>[1]> = {},
): MockElement {
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
    panelProvider: () => buildConnectionPanel({ status: 'synced' }),
    ...options,
  });
  void view.onOpen();
  return view.containerEl as unknown as MockElement;
}

describe('activity section in the pane', () => {
  it('names the Activity section even when the feed is empty', () => {
    const root = connectedPane({ activityFeedProvider: () => [] });
    const texts = flatten(root).map((el) => el.text);

    expect(texts.some((t) => t.includes('Activity'))).toBe(true);
  });

  it('says why it is empty rather than rendering a bare heading', () => {
    const root = connectedPane({ activityFeedProvider: () => [] });
    const texts = flatten(root).map((el) => el.text);

    expect(texts.some((t) => /no activity yet/i.test(t))).toBe(true);
  });
});

/**
 * The Activity tab draws a bounded number of rows.
 *
 * The activity log keeps 200 entries and `renderActivityRows` has a `limit`
 * option, but nothing passed it, so every repaint built all 200 rows at ~8 DOM
 * nodes each: roughly 1600 nodes, torn down and rebuilt each time. On a phone
 * that is a visible cost on a tab most people glance at.
 *
 * The cap is on RENDERING only. The log still holds its full history, so
 * nothing is lost; what changes is how much of it is in the DOM at once.
 */

import { describe, expect, it } from 'vitest';

import { buildConnectionPanel } from '../runtime/status';
import { WorkspaceLeaf, type MockElement } from '../test/obsidian.mock';

import { HavemindOnboardingView } from './onboarding-view';

function flatten(el: MockElement): MockElement[] {
  return [el, ...(el.children ?? []).flatMap(flatten)];
}

function feedOf(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    revisionId: `rev-${i}`,
    vaultId: 'vault-1',
    fileId: `file-${i}`,
    path: `Notes/note-${i}.md`,
    previousPath: null,
    kind: 'edit' as const,
    actor: {
      kind: 'author' as const,
      actorId: 'm-1',
      displayName: 'Alice',
    },
    timestamp: 1_000 + i,
    content: null,
    blobHash: `hash-${i}`,
    parentRevisionIds: [],
    provenance: [],
    restoredFromRevisionId: null,
  }));
}

function activityRowCount(entries: number): number {
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
    panelProvider: () => buildConnectionPanel({ status: 'synced' }),
    activityFeedProvider: () => feedOf(entries),
  });
  view.onOpen();
  const root = view.containerEl as unknown as MockElement;
  const tab = flatten(root).find(
    (el) => el.attrs?.['role'] === 'tab' && /activity/i.test(el.attrs?.['aria-label'] ?? ''),
  );
  tab?.triggerClick();
  return flatten(view.containerEl as unknown as MockElement).filter((el) =>
    (el.classes ?? []).includes('havemind-activity-row'),
  ).length;
}

describe('Activity rows are capped', () => {
  it('draws every row when the feed is short', () => {
    expect(activityRowCount(12)).toBe(12);
  });

  it('stops well short of the full 200-entry log', () => {
    const rows = activityRowCount(200);
    expect(rows).toBeLessThan(200);
    // Still enough to be a useful log rather than a teaser.
    expect(rows).toBeGreaterThanOrEqual(50);
  });
});

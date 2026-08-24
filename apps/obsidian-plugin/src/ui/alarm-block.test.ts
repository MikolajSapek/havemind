/**
 * Alarms are one block, not loose siblings.
 *
 * The design draws a conflict or a failed send as a single bordered region: an
 * accent rule down the left edge, a tinted ground, a heading, its rows, and a
 * hairline closing it off. The implementation drew the heading and the rows as
 * siblings of the pane, each carrying its own margin — so the tint stopped
 * short of the heading, nothing closed the block off underneath, and the accent
 * rule appeared beside the rows only.
 *
 * That is a structural difference, not a spacing one, which is why the CSS
 * tokens alone cannot fix it and why it needs a test of its own: the geometry
 * can be right in every value and still render as three detached fragments.
 */

import { describe, expect, it } from 'vitest';

import type { ConflictCopy } from '../runtime/conflict-resolution';
import { buildConnectionPanel } from '../runtime/status';
import { WorkspaceLeaf, type MockElement } from '../test/obsidian.mock';

import { HavemindOnboardingView, type OnboardingViewOptions } from './onboarding-view';

function flatten(el: MockElement): MockElement[] {
  return [el, ...(el.children ?? []).flatMap(flatten)];
}

function pane(options: OnboardingViewOptions = {}): MockElement {
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
    panelProvider: () => buildConnectionPanel({ status: 'synced' }),
    ...options,
  });
  view.onOpen();
  return view.containerEl as unknown as MockElement;
}

const TWO_CONFLICTS: readonly ConflictCopy[] = [
  {
    copyPath: 'Projects/Kiln notes (conflict).md',
    copyName: 'Kiln notes (conflict).md',
    kind: 'new',
    noteName: 'Projects/Kiln notes.md',
    author: 'Mira',
    timestamp: '10:04',
    isBinary: false,
    targetPath: 'Projects/Kiln notes.md',
    targetKnown: true,
    manualHint: null,
  },
  {
    copyPath: 'Meetings/Weekly (conflict).md',
    copyName: 'Weekly (conflict).md',
    kind: 'new',
    noteName: 'Meetings/Weekly.md',
    author: 'Tomas',
    timestamp: '09:41',
    isBinary: false,
    targetPath: 'Meetings/Weekly.md',
    targetKnown: true,
    manualHint: null,
  },
];

describe('alarm block — conflicts', () => {
  it('wraps the heading and every row in one block', () => {
    const root = pane({ conflictsProvider: () => TWO_CONFLICTS, onResolveConflict: () => {} });

    const blocks = flatten(root).filter((el) =>
      el.classes.includes('havemind-alarm'),
    );
    expect(blocks).toHaveLength(1);

    const block = blocks[0];
    if (block === undefined) throw new Error('no alarm block rendered');
    const inside = flatten(block);
    // The heading and both rows must be descendants of the block, not siblings
    // of it — that containment is what lets one border enclose the whole alarm.
    expect(
      inside.some((el) => el.classes.includes('havemind-conflict-header')),
    ).toBe(true);
    expect(
      inside.filter((el) => el.classes.includes('havemind-conflict-row')),
    ).toHaveLength(2);
  });

  it('draws no block when there is nothing to alarm about', () => {
    const root = pane({ conflictsProvider: () => [], onResolveConflict: () => {} });

    expect(
      flatten(root).some((el) => el.classes.includes('havemind-alarm')),
    ).toBe(false);
  });
});

describe('alarm block — failed sends', () => {
  it('wraps a failed send in the same block as conflicts use', () => {
    // One vocabulary for both alarms: a user who has learned to read the
    // conflict block should not have to learn a second shape for a failed send.
    const root = pane({
      sendQueueProvider: () => ({
        waitingCount: 0,
        failed: [
          {
            revisionId: 'r1',
            label: 'Attachments/scan-04.png',
            reason: 'Rejected by the server — too large',
          },
        ],
      }),
      onRetrySend: () => {},
      onDiscardSend: () => {},
    });

    const blocks = flatten(root).filter((el) =>
      el.classes.includes('havemind-alarm'),
    );
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block === undefined) throw new Error('no alarm block rendered');
    expect(
      flatten(block).some((el) => el.classes.includes('havemind-send-failed')),
    ).toBe(true);
  });
});

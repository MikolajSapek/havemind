/**
 * UI-02 / plans/007 Stage 2: hierarchy in the connected panel.
 *
 * "A healthy panel is nearly empty. Attention is a budget; spending it on
 * 'nothing is wrong' leaves none for 'something is'."
 *
 * Three tiers: the status row and anything actionable are always visible; idle
 * things collapse to a summary; the tutorial sits behind an affordance. The
 * load-bearing half is AT2-4: a conflict or a quarantined send must be visible
 * on FIRST PAINT, with no tab switch and no click, because `plan/01` rule 4
 * ("no silent overwrites") is only kept if the user can notice.
 */

import { describe, expect, it } from 'vitest';

import { buildRejoinRosterView } from '../runtime/rejoin-roster';
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

function texts(root: MockElement): string[] {
  return flatten(root)
    .map((el) => el.text ?? '')
    .filter((t) => t.length > 0);
}

const CONFLICT = {
  copyPath: 'Havemind Conflicts/a (Alice).md',
  copyName: 'a (Alice).md',
  kind: 'new' as const,
  noteName: 'a',
  author: 'Alice',
  timestamp: null,
  isBinary: false,
  targetPath: 'Notes/a.md',
  targetKnown: true,
  manualHint: null,
};

describe('UI-02, a healthy panel is nearly empty', () => {
  it('AT2-1: shows the status row and no alarm sections when all is well', () => {
    // The handlers ARE wired, as they are in the real plugin: without them the
    // sections bail out early and this test would pass for the wrong reason,
    // proving only that an unwired pane draws nothing.
    const root = pane({
      conflictsProvider: () => [],
      onResolveConflict: () => undefined,
      sendQueueProvider: () => null,
      onRetrySend: () => undefined,
      onDiscardSend: () => undefined,
    });

    // The status row is the one thing that always renders.
    expect(texts(root).some((t) => /synced/i.test(t))).toBe(true);

    // Nothing else spends the attention budget. Asserted on the alarm BLOCK,
    // not just its rows: an empty conflicts section still draws its border,
    // tint and left rule, which is exactly the "a healthy panel looks as busy
    // as a broken one" defect Stage 2 exists to remove.
    const classes = flatten(root).flatMap((el) => el.classes ?? []);
    expect(classes).not.toContain('havemind-alarm');
    expect(classes).not.toContain('havemind-alarm-conflict');
    expect(classes).not.toContain('havemind-conflict-row');
    expect(classes.some((c) => /send-queue|pending-row/.test(c))).toBe(false);
    // And the Status tab carries no attention count when nothing needs one.
    expect(classes).not.toContain('needs-attention');
  });

  it('AT2-2: one conflict is visible without interaction', () => {
    const root = pane({ conflictsProvider: () => [CONFLICT], onResolveConflict: () => undefined });

    // The section states its own count and names the note; a conflict is
    // legible without opening anything.
    expect(texts(root).some((t) => /1 conflict/.test(t))).toBe(true);
    const classes = flatten(root).flatMap((el) => el.classes ?? []);
    expect(classes).toContain('havemind-conflict-row');
  });

  it('AT2-4: a conflict is on first paint, above the tabs, on every tab', () => {
    // The negative AC. A tab may hide content; it must never hide an alarm, so
    // the conflict has to sit ABOVE the tab strip in DOM order rather than
    // inside whichever tab happens to be open.
    const root = pane({ conflictsProvider: () => [CONFLICT], onResolveConflict: () => undefined });

    const all = flatten(root);
    const strip = all.findIndex((el) => (el.classes ?? []).includes('havemind-tabs'));
    const conflict = all.findIndex((el) =>
      (el.classes ?? []).includes('havemind-alarm-conflict'),
    );

    expect(strip).toBeGreaterThan(-1);
    expect(conflict).toBeGreaterThan(-1);
    expect(conflict).toBeLessThan(strip);
  });

  it('AT2-3: the roster is not in the calm pane; it lives behind the People tab', () => {
    // Stage 2 asks for a collapsed roster. The tabbed pane satisfies the same
    // requirement more strongly: the member rows are behind a named tab rather
    // than a summary line, so a healthy Status tab carries none of them.
    const roster = buildRejoinRosterView([
      { membershipId: 'm-1', displayName: 'You', role: 'owner', self: true },
      { membershipId: 'm-2', displayName: 'Bob', role: 'editor', self: false },
    ]);
    const root = pane({ rejoinRosterProvider: () => roster });

    expect(texts(root).some((t) => /^Bob$/.test(t))).toBe(false);
    // And the tab that holds them is reachable without the command palette.
    const tabLabels = flatten(root)
      .filter((el) => el.attrs?.['role'] === 'tab')
      .map((el) => el.attrs?.['aria-label'] ?? '');
    expect(tabLabels.some((l) => /people/i.test(l))).toBe(true);
  });

  it('AT2-4: the tutorial stays behind its affordance in a healthy pane', () => {
    const root = pane();
    expect(texts(root).some((t) => /Install Docker/i.test(t))).toBe(false);
  });
});

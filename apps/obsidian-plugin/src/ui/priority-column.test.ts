/**
 * The priority column (design 1a, plans/007 Phase A).
 *
 * The designer rejected tabs outright: five destinations do not fit 300px, and
 * tabs hide the state that matters behind a click, which then forces a badge
 * vocabulary to undo the hiding. What replaces them is one scrolling column
 * where anything actionable injects itself under the status and everything idle
 * collapses to a summary row carrying a count.
 *
 * These tests pin the parts of that which are behavioural rather than visual:
 * what exists in a calm pane, what appears when something needs the user, and
 * what never renders at all.
 */

import { describe, expect, it } from 'vitest';

import { buildRejoinRosterView } from '../runtime/rejoin-roster';
import { buildConnectionPanel } from '../runtime/status';
import {
  WorkspaceLeaf,
  type MockElement,
} from '../test/obsidian.mock';

import { HavemindOnboardingView, type OnboardingViewOptions } from './onboarding-view';

function flatten(el: MockElement): MockElement[] {
  return [el, ...(el.children ?? []).flatMap(flatten)];
}

function pane(options: OnboardingViewOptions = {}): MockElement {
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
    panelProvider: () => buildConnectionPanel({ status: 'synced' }),
    ...options,
  });
  // The mock renders synchronously, but read the container *after* the call so
  // the tree is the rendered one rather than an empty shell.
  view.onOpen();
  return view.containerEl as unknown as MockElement;
}

function texts(root: MockElement): string[] {
  return flatten(root).map((el) => el.text);
}

describe('priority column — header', () => {
  it('offers an overflow menu instead of a standing Disconnect button', () => {
    // The designer cut the "Connection" block that echoed the user's own server
    // URL: nobody needs their own address daily. It moves to the header
    // overflow with Disconnect and Reset.
    const root = pane();
    const labels = flatten(root).map((el) => el.attrs['aria-label'] ?? '');

    expect(labels.some((l) => /more options/i.test(l))).toBe(true);
  });

  it('does not spend a line on the user own server address', () => {
    const root = pane({
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'sap.ts.net' }),
    });

    expect(texts(root).some((t) => t.includes('sap.ts.net'))).toBe(false);
  });
});

describe('priority column — calm state', () => {
  it('keeps a proof-of-life line so a stalled pane is distinguishable', () => {
    // The designer pushed back on "nearly empty": a pane showing only "Synced"
    // reads the same as one that stopped updating three days ago. The calm
    // state keeps a detail line under the status word — recency when there is
    // any, and always the honest note about what the server can read.
    const root = pane();
    const detail = flatten(root).find((el) =>
      el.classes.includes('havemind-status-detail'),
    );

    expect(detail).toBeDefined();
    expect((detail?.text ?? '').length).toBeGreaterThan(0);
  });

  it('renders no uppercase section captions', () => {
    // Seven captions cost seven lines and each repeated the row beneath it.
    const root = pane();
    const shouty = texts(root).filter(
      (t) => t.length > 3 && t === t.toUpperCase() && /[A-Z]{4,}/.test(t),
    );

    expect(shouty).toEqual([]);
  });
});

describe('entry chooser', () => {
  it('asks which path a fresh user is on', () => {
    const root = pane({
      panelProvider: () => buildConnectionPanel({ status: 'disconnected' }),
    });

    expect(texts(root).some((t) => /sent me an invitation/i.test(t))).toBe(true);
    // The Docker tutorial is behind the host branch, not above the form.
    expect(texts(root).some((t) => /Install Docker/i.test(t))).toBe(false);
  });

  it('skips the question for someone who followed a join link', () => {
    // Clicking obsidian://havemind-join already answers it: that user holds an
    // invitation. Asking anyway makes them answer twice.
    const root = pane({
      panelProvider: () => buildConnectionPanel({ status: 'disconnected' }),
      arrivedWithInvitationProvider: () => true,
    });

    expect(texts(root).some((t) => /sent me an invitation/i.test(t))).toBe(false);
    expect(flatten(root).some((el) => el.tag === 'textarea')).toBe(true);
  });
});

describe('priority column — no duplicated sections', () => {
  it('draws the roster once when the composer is open', () => {
    // The composer carried its own roster from when it was a separate screen.
    // Once it moved inside the People tab — which already draws the roster —
    // that left "Connected / You" rendered twice in one pane.
    //
    // An open composer selects People on its own, so no click is needed here:
    // that selection is exactly what put the two rosters on the same tab.
    const root = pane({
      rejoinRosterProvider: () =>
        buildRejoinRosterView(
          [
            {
              membershipId: 'm1',
              displayName: 'You',
              role: 'owner',
              self: true,
            },
          ],
          [],
        ),
      rejoinWaitingProvider: () => new Set<string>(),
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: null,
        pending: [],
      }),
    });

    const rosterRows = flatten(root).filter((el) =>
      el.classes.includes('havemind-roster-row'),
    );
    expect(rosterRows).toHaveLength(1);
  });
});

describe('priority column — footer', () => {
  it('carries the authorship toggle that lost its ribbon icon', () => {
    let toggled = 0;
    const root = pane({
      authorOverlayProvider: () => false,
      onToggleAuthorOverlay: () => {
        toggled += 1;
      },
    });

    // Icon-only in the action bar (design 2a), so its accessible name lives in
    // aria-label rather than in visible text — which is precisely why the
    // label has to exist.
    const toggle = flatten(root).find((el) =>
      /authorship/i.test(el.attrs['aria-label'] ?? ''),
    );
    expect(toggle).toBeDefined();

    toggle?.triggerClick();
    expect(toggled).toBe(1);
  });

  it('states the toggle position for a screen reader, not by colour alone', () => {
    const root = pane({
      authorOverlayProvider: () => true,
      onToggleAuthorOverlay: () => {},
    });

    const pressed = flatten(root).some(
      (el) => el.attrs['aria-pressed'] === 'true',
    );
    expect(pressed).toBe(true);
  });
});

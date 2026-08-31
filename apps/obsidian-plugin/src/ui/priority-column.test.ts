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

describe('connection controls', () => {
  it('makes connection management a visible tab', () => {
    const root = pane({
      panelProvider: () =>
        buildConnectionPanel({ status: 'synced', serverName: 'sap.ts.net' }),
      onSyncNow: () => {},
      onDisconnect: () => {},
    });
    const connect = flatten(root).find(
      (el) => el.attrs['role'] === 'tab' && /connect/i.test(el.attrs['aria-label'] ?? ''),
    );

    expect(connect).toBeDefined();
    connect?.triggerClick();

    const visible = texts(root).join(' ');
    expect(visible).toContain('sap.ts.net');
    expect(visible).toContain('Sync now');
    expect(visible).toContain('Disconnect and change server');
  });
});

describe('priority column, calm state', () => {
  it('keeps a proof-of-life line so a stalled pane is distinguishable', () => {
    // The designer pushed back on "nearly empty": a pane showing only "Synced"
    // reads the same as one that stopped updating three days ago. The calm
    // state keeps a detail line under the status word, recency when there is
    // any, and always the honest note about what the server can read.
    const root = pane();
    const detail = flatten(root).find((el) =>
      el.classes.includes('havemind-status-detail'),
    );

    expect(detail).toBeDefined();
    expect(flatten(detail as MockElement).map((el) => el.text).join('')).not.toBe('');
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

  it('keeps typed input when the host path hands you back to the chooser', () => {
    // AT1-4. The back affordance is only safe if it is not also a way to lose
    // a pasted invitation: someone who pastes, wanders into the host branch to
    // check what it costs, and comes back must find their token still there.
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () => buildConnectionPanel({ status: 'disconnected' }),
    });
    view.onOpen();
    const root = view.containerEl as unknown as MockElement;

    const options = flatten(root).filter((el) =>
      (el.classes ?? []).includes('havemind-entry-option'),
    );
    expect(options).toHaveLength(2);
    options[0]?.triggerClick();

    const field = flatten(view.containerEl as unknown as MockElement).find(
      (el) => el.tag === 'textarea',
    );
    if (field === undefined) throw new Error('paste field not rendered');
    field.value = 'havemind-invitation-token';

    const backToChooser = flatten(
      view.containerEl as unknown as MockElement,
    ).find((el) => el.text === 'Back');
    backToChooser?.triggerClick();
    const host = flatten(view.containerEl as unknown as MockElement).filter(
      (el) => (el.classes ?? []).includes('havemind-entry-option'),
    )[1];
    host?.triggerClick();
    const back = flatten(view.containerEl as unknown as MockElement).find(
      (el) => el.text === 'Back',
    );
    back?.triggerClick();

    const restored = flatten(view.containerEl as unknown as MockElement).find(
      (el) => el.tag === 'textarea',
    );
    expect(restored?.value).toBe('havemind-invitation-token');
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

describe('priority column, no duplicated sections', () => {
  it('lets the owner close the invite composer before creating an invitation', () => {
    let closed = 0;
    const root = pane({
      composerProvider: () => ({
        role: 'editor',
        name: '',
        invitation: null,
        pending: [],
      }),
      onCloseComposer: () => {
        closed += 1;
      },
    });

    const close = flatten(root).find((el) => el.text === 'Close');
    expect(close).toBeDefined();
    close?.triggerClick();
    expect(closed).toBe(1);
  });

  it('draws the roster once when the composer is open', () => {
    // The composer carried its own roster from when it was a separate screen.
    // Once it moved inside the People tab, which already draws the roster,
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

describe('priority column, footer', () => {
  it('carries the authorship toggle that lost its ribbon icon', () => {
    let toggled = 0;
    const root = pane({
      authorOverlayProvider: () => false,
      onToggleAuthorOverlay: () => {
        toggled += 1;
      },
    });

    // Icon-only in the action bar (design 2a), so its accessible name lives in
    // aria-label rather than in visible text, which is precisely why the
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

/**
 * AT3-1: the pane's screen precedence, as a table.
 *
 * `render()` decided which screen to draw with an ordered `if … return` chain,
 * so precedence lived in statement order and nothing could assert it. That is
 * not a theoretical risk: it shipped once as the 1.1.3 defect, where the
 * Create-connection composer took the first branch and returned before the
 * status row was drawn, so a connected vault displayed no "Connected, synced"
 * anywhere and read as disconnected.
 *
 * The order below is the one the chain already implemented, lifted out and
 * pinned: invalid beats awaiting beats connected beats joining/hosting beats
 * choosing.
 */

import { describe, expect, it } from 'vitest';

import { buildConnectionPanel } from './status';
import { resolveViewState, type ViewStateSources } from './view-state';

const CONNECTED = buildConnectionPanel({ status: 'synced' });
const DISCONNECTED = buildConnectionPanel({ status: 'disconnected' });
const WAITING = { verificationPhrase: 'six word phrase here now please' };

function sources(overrides: Partial<ViewStateSources> = {}): ViewStateSources {
  return {
    guestInvalid: false,
    guestWaiting: null,
    panel: DISCONNECTED,
    entryChoice: 'undecided',
    joinLinkFollowed: false,
    composerOpen: false,
    ...overrides,
  };
}

describe('resolveViewState precedence', () => {
  const cases: ReadonlyArray<
    readonly [string, Partial<ViewStateSources>, string]
  > = [
    // Invalid is terminal and outranks everything: the invitation is spent, so
    // leaving the guest on a waiting screen would be a lie that never resolves.
    ['invalid beats everything', { guestInvalid: true, guestWaiting: WAITING, panel: CONNECTED }, 'invalid'],
    ['invalid beats awaiting', { guestInvalid: true, guestWaiting: WAITING }, 'invalid'],
    ['awaiting beats connected', { guestWaiting: WAITING, panel: CONNECTED }, 'awaiting'],
    ['awaiting beats choosing', { guestWaiting: WAITING }, 'awaiting'],
    ['connected when a panel is live', { panel: CONNECTED }, 'connected'],
    // The composer is deliberately NOT a state: it is a modal over the
    // connected panel, which is what makes the 1.1.3 defect structurally
    // impossible rather than merely fixed.
    ['composer does not displace connected', { panel: CONNECTED, composerOpen: true }, 'connected'],
    ['joining once the path is picked', { entryChoice: 'joining' }, 'joining'],
    ['hosting once the path is picked', { entryChoice: 'hosting' }, 'hosting'],
    ['a join link skips the chooser', { joinLinkFollowed: true }, 'joining'],
    ['choosing is the default', {}, 'choosing'],
  ];

  it.each(cases)('%s', (_name, overrides, expected) => {
    expect(resolveViewState(sources(overrides)).kind).toBe(expected);
  });

  it('carries the panel on the connected state', () => {
    const state = resolveViewState(sources({ panel: CONNECTED }));
    expect(state.kind === 'connected' && state.panel).toBe(CONNECTED);
  });

  it('carries the waiting model on the awaiting state', () => {
    const state = resolveViewState(sources({ guestWaiting: WAITING }));
    expect(state.kind === 'awaiting' && state.waiting).toBe(WAITING);
  });
});

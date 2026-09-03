/**
 * Which screen the pane shows, as data rather than as statement order.
 *
 * `render()` used to decide with an ordered `if … return` chain, so precedence
 * was implicit in the order the branches happened to be written and no test
 * could reach it. That shipped as the 1.1.3 defect: the Create-connection
 * composer took the first branch and returned before the status row was drawn,
 * so a connected vault rendered no "Connected, synced" and read as
 * disconnected. Making the decision a pure function makes the ordering a thing
 * that can be asserted (AT3-1).
 *
 * Pure: no DOM, no Obsidian import, so it is testable in isolation.
 */

import type { EntryChoice } from './entry-choice';
import type { ConnectionPanelView } from './status';

/** The waiting-for-approval model, structurally what the view renders. */
export interface GuestWaiting {
  readonly verificationPhrase: string;
  readonly ownerName?: string;
}

/** Everything the decision reads, already resolved to values. */
export interface ViewStateSources {
  /** The invitation was refused or spent; terminal. */
  readonly guestInvalid: boolean;
  /** Non-null while this device waits for the owner to approve it. */
  readonly guestWaiting: GuestWaiting | null;
  readonly panel: ConnectionPanelView;
  /** Which entry path the user picked, if any. */
  readonly entryChoice: EntryChoice;
  /**
   * True when the user has self-evidently already chosen the joining path: a
   * `havemind-join` URI brought them here, or they have a token typed. Either
   * way the chooser's question is already answered, so asking it again would be
   * asking twice.
   */
  readonly joinLinkFollowed: boolean;
  /**
   * Whether the owner's invitation composer is open. Read but deliberately NOT
   * a state of its own: see below.
   */
  readonly composerOpen: boolean;
}

/**
 * The screens, one variant each.
 *
 * The composer is deliberately absent. Creating an invitation is a momentary
 * task drawn as a modal OVER the connected panel, so it cannot occlude a
 * screen; that removes the whole class of "the status row vanished" defects
 * instead of patching another instance of it.
 */
export type ViewState =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'awaiting'; readonly waiting: GuestWaiting }
  | { readonly kind: 'connected'; readonly panel: ConnectionPanelView }
  | { readonly kind: 'joining' }
  | { readonly kind: 'hosting' }
  | { readonly kind: 'choosing' };

/**
 * Resolves the one screen to draw.
 *
 * Order is the contract, and it is the order the old chain implemented:
 * invalid → awaiting → connected → joining/hosting → choosing. Each step is
 * "more terminal" than the next, so a state that cannot be escaped is never
 * hidden behind one that can.
 */
export function resolveViewState(sources: ViewStateSources): ViewState {
  // Terminal: the invitation is spent, so a waiting screen here would be a
  // promise that never resolves.
  if (sources.guestInvalid) return { kind: 'invalid' };

  if (sources.guestWaiting !== null) {
    return { kind: 'awaiting', waiting: sources.guestWaiting };
  }

  // `showForm` is the panel's own answer to "is there a connection to show?".
  // Disconnected is the safe default upstream, so this stays a read, not a
  // second judgement.
  if (!sources.panel.showForm) {
    return { kind: 'connected', panel: sources.panel };
  }

  // A join link is an answer to the chooser's question, so it skips asking.
  if (sources.joinLinkFollowed) return { kind: 'joining' };
  if (sources.entryChoice === 'joining') return { kind: 'joining' };
  if (sources.entryChoice === 'hosting') return { kind: 'hosting' };

  return { kind: 'choosing' };
}

/**
 * Exhaustiveness guard for a `switch` over {@link ViewState} (AT3-3).
 *
 * Because the parameter is `never`, an unhandled variant makes the call a type
 * error: `tsc` reports the missing arm at the call site rather than letting the
 * switch fall through and render nothing. It throws at runtime as well, for the
 * paths the type system cannot see (a cast, a JS caller, a stale bundle),
 * because a loud failure beats a silently blank pane.
 */
export function assertNever(value: never): never {
  throw new Error(
    `unhandled ViewState variant: ${JSON.stringify(value)}`,
  );
}

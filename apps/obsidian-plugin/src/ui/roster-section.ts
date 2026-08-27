/**
 * The "Connected" presence roster section and the owner actions attached to each
 * of its rows (Rejoin, Mark offline, Remove). It is drawn in both the owner
 * composer and the connected panel, so it lives in its own module rather than
 * inside either one. Presence here is connection state, never derived from
 * activity, and every colour dot is paired with a text status label so colour is
 * never the only signal. Presentation only, the destructive actions are
 * two-step confirms that call back into the plugin.
 */

import type { RejoinRosterView } from '../runtime/rejoin-roster';

import { DECORATIVE } from './primitives';

/** Owner actions attached to each rejoin-aware roster row. */
export interface RejoinRosterActions {
  /** Membership ids the owner has already asked to rejoin (awaiting reconnect). */
  readonly waiting: ReadonlySet<string>;
  /** Owner clicked Rejoin on a disconnected contact, issue the grant. */
  readonly onRejoin?: (membershipId: string) => void;
  /** Owner asserts a connected contact fell off, arming its Rejoin affordance. */
  readonly onMarkDisconnected?: (membershipId: string) => void;
  /** Owner permanently removes a member from the vault (destructive, two-step). */
  readonly onRemove?: (membershipId: string) => void;
}

/**
 * Renders the "Connected" presence roster with the F9 rejoin affordance. Each
 * row pairs the member's stable colour dot with a text status label (never
 * colour alone): a green dot + "connected" for a live member, or a muted dot +
 * "disconnected" + a Rejoin button for a known-dead contact. Presence is
 * CONNECTION STATE, a member stays connected until an explicit teardown, never
 * derived from activity.
 *
 * Pilot heuristic (documented choice): no server-side liveness signal reaches
 * the owner's client yet, so "disconnected" is owner-asserted, the owner marks
 * a contact's row disconnected, which arms its Rejoin button. Clicking Rejoin
 * re-admits that exact contact without re-running pairing.
 */
export function renderRejoinRoster(
  content: HTMLElement,
  roster: RejoinRosterView,
  actions: RejoinRosterActions,
): void {
  content.createEl('h4', { text: 'Connected' });
  if (roster.empty) {
    const empty = content.createDiv({
      text: 'No members yet. Approved devices appear here as connected.',
    });
    empty.addClass('havemind-empty');
    return;
  }
  for (const row of roster.rows) {
    const item = content.createDiv({ text: '' });
    item.addClass('havemind-roster-row');
    // Colour dot coloured by the member's stable token, paired with the text
    // status label below so colour is never the only signal.
    const dot = item.createEl('span', { attr: DECORATIVE });
    dot.addClass('havemind-roster-dot');
    if (!row.connected) dot.addClass('is-disconnected');
    // The owner's own row uses the theme accent; other members keep their stable
    // author colour. Colour is always paired with the name + status text below.
    dot.style.setProperty(
      'color',
      row.self ? 'var(--interactive-accent)' : `var(${row.colorToken})`,
    );
    const text = item.createDiv();
    text.addClass('havemind-roster-copy');
    text.createDiv({ text: row.displayName }).addClass('havemind-roster-name');
    const meta = text.createDiv({
      text: row.self
        ? `${row.role} · you`
        : `${row.role} · ${row.statusLabel}`,
    });
    meta.addClass('havemind-hint');
    meta.addClass('havemind-roster-meta');

    if (row.rejoinable && actions.onRejoin) {
      if (actions.waiting.has(row.membershipId)) {
        const status = item.createDiv({
          text: `Waiting for ${row.displayName} to reconnect…`,
        });
        status.addClass('havemind-rejoin-waiting');
      } else {
        const rejoin = item.createEl('button', { text: 'Rejoin' });
        rejoin.addClass('mod-cta');
        rejoin.addClass('havemind-roster-action');
        rejoin.onClickEvent(() => actions.onRejoin?.(row.membershipId));
      }
    } else if (row.connected && !row.self && actions.onMarkDisconnected) {
      // Owner-asserted disconnect: clicking arms this contact's Rejoin button.
      const mark = item.createEl('button', { text: 'Mark offline' });
      mark.addClass('havemind-roster-action');
      mark.onClickEvent(() => actions.onMarkDisconnected?.(row.membershipId));
    }

    // Remove is offered on every non-self member regardless of connection
    // state. It is destructive (mod-warning, never mod-cta) and gated behind an
    // inline two-step confirm: the first click arms "Confirm remove", the second
    // click within the same render executes. No window.confirm, it blocks
    // Electron and would freeze the pane.
    if (row.removable && actions.onRemove) {
      let armed = false;
      let executed = false;
      const remove = item.createEl('button', { text: 'Remove' });
      remove.addClass('mod-warning');
      remove.addClass('havemind-roster-action');
      remove.onClickEvent(() => {
        if (executed) {
          return;
        }
        if (!armed) {
          armed = true;
          remove.setText('Confirm remove');
          remove.addClass('havemind-roster-action-armed');
          return;
        }
        // Fire exactly once: the success path re-renders the roster (dropping
        // this row), but guard here too so a stray click before that re-render
        // can never submit a second removal.
        executed = true;
        actions.onRemove?.(row.membershipId);
      });
    }
  }
}

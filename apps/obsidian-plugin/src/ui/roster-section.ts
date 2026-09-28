/**
 * The People roster and the owner actions on each row (Rejoin, Remove). Drawn
 * in both the owner composer and the connected panel. Every colour dot is
 * paired with the member's name and role, so colour is never the only signal.
 * The server reports no presence, so no connected/disconnected state is shown.
 */

import type { RejoinRosterView } from '../runtime/rejoin-roster';

import { DECORATIVE } from './primitives';

/** Owner actions attached to each rejoin-aware roster row. */
export interface RejoinRosterActions {
  /** Membership ids the owner has already asked to rejoin (awaiting reconnect). */
  readonly waiting: ReadonlySet<string>;
  /** Owner clicked Rejoin on a member whose device lost its session. */
  readonly onRejoin?: (membershipId: string) => void;
  /** Owner permanently removes a member from the vault (destructive, two-step). */
  readonly onRemove?: (membershipId: string) => void;
}

export function renderRejoinRoster(
  content: HTMLElement,
  roster: RejoinRosterView,
  actions: RejoinRosterActions,
): void {
  content.createEl('h4', { text: 'Members' });
  if (roster.empty) {
    const empty = content.createDiv({
      text: 'No members yet. Approved devices appear here.',
    });
    empty.addClass('havemind-empty');
    return;
  }
  for (const row of roster.rows) {
    const item = content.createDiv({ text: '' });
    item.addClass('havemind-roster-row');
    // Colour dot in the member's stable token, paired with name and role.
    const dot = item.createEl('span', { attr: DECORATIVE });
    dot.addClass('havemind-roster-dot');
    // The owner's own row uses the theme accent; other members keep their stable
    // author colour.
    dot.style.setProperty(
      'color',
      row.self ? 'var(--interactive-accent)' : `var(${row.colorToken})`,
    );
    const text = item.createDiv();
    text.addClass('havemind-roster-copy');
    text.createDiv({ text: row.displayName }).addClass('havemind-roster-name');
    const meta = text.createDiv({
      text: row.self ? `${row.role} · you` : row.role,
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
        rejoin.addClass('havemind-roster-action');
        rejoin.onClickEvent(() => actions.onRejoin?.(row.membershipId));
      }
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

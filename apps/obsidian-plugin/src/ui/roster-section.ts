/**
 * The People roster: a name and a role per member (plan 010), plus the owner's
 * Rejoin and Remove. The server reports no presence, so no
 * connected/disconnected state is shown.
 */

import type { RejoinRosterView } from '../runtime/rejoin-roster';

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
  if (roster.empty) {
    const empty = content.createDiv({
      text: 'No members yet. Approved devices appear here.',
    });
    empty.addClass('havemind-empty');
    return;
  }
  // Rejoin and Remove are owner actions; the server refuses both from an editor.
  const ownerView = roster.rows.some((row) => row.self && row.role === 'owner');
  for (const row of roster.rows) {
    const item = content.createDiv({ text: '' });
    item.addClass('havemind-roster-row');
    const text = item.createDiv();
    text.addClass('havemind-roster-copy');
    text.createDiv({ text: row.displayName }).addClass('havemind-roster-name');
    const role = row.role === 'owner' ? 'Owner' : 'Editor';
    const meta = text.createDiv({ text: row.self ? `${role} · this device` : role });
    meta.addClass('havemind-roster-meta');
    if (!ownerView) continue;

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

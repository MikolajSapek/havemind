/**
 * Terminal guest screen after the owner rejected this device, or the
 * three-attempt cap was reached.
 *
 * Never a blank screen (design 1e): name the cause, price the fix in the other
 * person's time so asking for a new invitation feels cheap, and still offer the
 * paste form so there is a way forward rather than a dead end.
 */

import { setIcon } from 'obsidian';

import { buildSpentInvitation } from '../../runtime/handshake';
import { DECORATIVE } from '../primitives';

export interface GuestInvalidActions {
  /** Draws the paste form, which the caller owns (it holds the draft). */
  readonly renderForm: (content: HTMLElement) => void;
}

export function renderGuestInvalid(
  content: HTMLElement,
  ownerName: string | undefined,
  actions: GuestInvalidActions,
): void {
  const view = buildSpentInvitation(ownerName);

  const row = content.createDiv({ text: '' });
  row.addClass('havemind-status');
  row.style.setProperty('color', 'var(--text-error)');
  setIcon(row.createEl('span', { attr: DECORATIVE }), 'alert-triangle');
  row.createEl('span', { text: ` ${view.heading}` });

  content.createDiv({ text: view.explanation }).addClass('havemind-hint');
  actions.renderForm(content);
}

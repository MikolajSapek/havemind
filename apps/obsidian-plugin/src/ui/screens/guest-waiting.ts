/**
 * The guest's waiting screen: read six digits to the person who invited you,
 * while they approve this device.
 *
 * Extracted from `onboarding-view.ts` for Stage 3. It takes a model and one
 * callback rather than the view, so it renders without a pane, an Obsidian
 * leaf, or any of the view's state.
 */

import { buildGuestHandshake } from '../../runtime/handshake';
import type { GuestWaiting } from '../../runtime/view-state';

export interface GuestWaitingActions {
  /** Abandons the pending join. */
  readonly onCancel?: (() => void) | undefined;
}

export function renderGuestWaitingScreen(
  content: HTMLElement,
  model: GuestWaiting,
  actions: GuestWaitingActions = {},
): void {
  // The code is the only thing at full size (design 1e): this screen exists for
  // one job, and everything competing with the digits makes that job harder
  // while another person waits on the phone.
  const view = buildGuestHandshake({
    code: model.verificationPhrase,
    ...(model.ownerName !== undefined ? { ownerName: model.ownerName } : {}),
  });

  content.createDiv({ text: view.instruction }).addClass('havemind-handshake-lead');

  const digits = content.createDiv();
  digits.addClass('havemind-handshake-code');
  // Announced as one string so a screen reader reads "482917", not two
  // unrelated numbers; sighted users get the 3+3 grouping that makes it
  // speakable.
  digits.setAttribute('aria-label', view.code.join(''));
  for (const group of view.code) {
    digits.createEl('span', { text: group });
  }

  content
    .createDiv({ text: view.mismatchWarning })
    .addClass('havemind-handshake-warning');

  if (view.expiryLabel !== null) {
    content
      .createDiv({ text: `Expires in ${view.expiryLabel}` })
      .addClass('havemind-hint');
  }
  content.createDiv({ text: view.liveNote }).addClass('havemind-hint');

  const cancel = content.createEl('button', { text: 'Cancel' });
  cancel.onClickEvent(() => actions.onCancel?.());
}

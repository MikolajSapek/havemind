/**
 * The minted invitation: the envelope to hand over, a Copy button, and the
 * expiry. Split out of the composer so each half stays readable.
 *
 * Two rules live here. An EXPIRED single-use invite withholds the envelope
 * entirely rather than offering a string that can never be redeemed. And the
 * hand-selectable copy is genuinely readonly, because Copy sends the ORIGINAL
 * envelope: an editable field would let the owner hand over something other
 * than what they see, a silent mismatch in the one string that must be exact.
 */

import type { InviteComposerActions, InviteComposerModel } from './invite-composer';

const COPY_FAILED =
  'Could not copy automatically. Select and copy the invitation manually.';

export function renderInvitationEnvelope(
  content: HTMLElement,
  model: InviteComposerModel,
  actions: InviteComposerActions,
): void {
  if (model.invitation === null) return;
  const envelope = model.invitation.envelope;


  if (model.invitationExpired === true) {
    // No dead-end: an expired single-use invite can never be redeemed, so the
    // envelope is withheld and the owner is pointed back to Create invitation.
    content
      .createDiv({
        text: 'This invitation expired. Create a new one above to invite the other device.',
      })
      .addClass('havemind-hint');
    const dismiss = content.createEl('button', { text: 'Done' });
    dismiss.onClickEvent(() => actions.onDismiss?.());
    return;
  }

  content
    .createDiv({
      text: 'Invite created, copy it and send it to the other device. Single-use, expires in 15 minutes.',
    })
    .addClass('havemind-hint');
  const code = content.createEl('code', { text: envelope });
  code.addClass('havemind-invite-envelope');
  // A hand-selectable copy for when the clipboard is unavailable or denied.
  // Genuinely readonly, not merely described as such: Copy sends the ORIGINAL
  // envelope, so an edited field would hand the owner something other than what
  // they can see, a silent mismatch in the one string that must be exact.
  const fallback = content.createEl('textarea', {
    value: envelope,
    cls: 'havemind-invite-copy-fallback',
    attr: {
      id: 'havemind-invite-envelope-text',
      readonly: 'true',
      'aria-label': 'Invitation to copy',
    },
  });
  fallback.setAttribute('readonly', 'true');
  const copyStatus = content.createDiv({ text: '' });
  copyStatus.addClass('havemind-form-status');
  const copy = content.createEl('button', { text: 'Copy' });
  copy.addClass('mod-cta');
  copy.onClickEvent(() => {
    void Promise.resolve(actions.onCopy?.(envelope) ?? false).then(
      (copied) => {
        copyStatus.setText(copied ? 'Copied to clipboard.' : COPY_FAILED);
      },
      () => copyStatus.setText(COPY_FAILED),
    );
  });
  content
    .createDiv({ text: `Expires: ${model.invitation.expiresAt}` })
    .addClass('havemind-hint');
  // Done clears the envelope display so it is not a permanent dead-end.
  const dismiss = content.createEl('button', { text: 'Done' });
  dismiss.onClickEvent(() => actions.onDismiss?.());
}

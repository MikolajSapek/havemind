/**
 * One waiting device, with the field where the owner types the six digits the
 * joining device reads aloud.
 *
 * Its own module because it is the security-critical half of the composer: the
 * owner never sees the code, they type in what they HEAR, which is what makes
 * the read-aloud check meaningful. Kept small enough to read whole.
 */

import { setIcon } from 'obsidian';

import type { PendingApprovalEntry } from '../onboarding-view';
import { DECORATIVE, renderFormStatus } from '../primitives';

export interface PendingApprovalActions {
  readonly onApprove?:
    | ((invitationId: string, phrase: string, report: (message: string) => void) => void)
    | undefined;
}

export function renderPendingRow(
  content: HTMLElement,
  entry: PendingApprovalEntry,
  actions: PendingApprovalActions,
): void {
  // Icon + label + colour (never colour alone), matching the Connect panel
  // indicator convention.
  const row = content.createDiv({ text: '' });
  row.addClass('havemind-pending-row');
  row.style.setProperty('color', 'var(--text-accent)');
  setIcon(row.createEl('span', { attr: DECORATIVE }), 'user-round-check');
  row.createEl('span', {
    text: ` ${entry.intendedMemberDisplayName ?? 'Pending device'} · expires ${entry.expiresAt}`,
  });
  // The owner never sees the code: they type in what the joining device reads
  // aloud, so the human read-aloud check is meaningful (the code travels only
  // over the out-of-band voice channel). The id carries the invitation, because
  // several devices can wait at once and a shared id would leave every field
  // after the first unnamed.
  const phraseId = `havemind-approve-${entry.invitationId}`;
  row.createEl('label', {
    text: 'Enter the 6-digit code your peer reads to you',
    attr: { for: phraseId },
  });
  const phraseInput = row.createEl('input', {
    type: 'text',
    placeholder: '123456',
    attr: { id: phraseId, inputmode: 'numeric', maxlength: '6', pattern: '[0-9]*' },
  });
  const status = renderFormStatus(row);
  const approve = row.createEl('button', { text: 'Approve' });
  approve.addClass('mod-cta');
  approve.onClickEvent(() => {
    const phrase = phraseInput.value.trim();
    if (phrase.length === 0) {
      status.setText('Enter the code you heard, then approve.');
      return;
    }
    status.setText('Approving…');
    // The row is not re-rendered on a wrong code, so the input keeps its value
    // and focus and the owner can correct the code and retry.
    actions.onApprove?.(entry.invitationId, phrase, (message) =>
      status.setText(message),
    );
  });
}

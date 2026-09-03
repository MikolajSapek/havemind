/**
 * The owner's invitation composer: mint an invitation, hand it over, then
 * approve the device that redeems it.
 *
 * Extracted from `onboarding-view.ts` for Stage 3. It takes a model, a draft
 * and a bag of callbacks rather than the view, so it renders without a pane or
 * a leaf. The draft and the live-input handles stay owned by the caller: the
 * pane re-renders on every status change, and typed-but-unsubmitted values have
 * to survive that.
 */

import { setIcon } from 'obsidian';

import type {
  InvitationRole,
  PendingApprovalEntry,
} from '../onboarding-view';

import { renderInvitationEnvelope } from './invitation-envelope';
import { renderPendingRow } from './pending-approval-row';
import {
  DECORATIVE,
  labelledField,
  renderFormStatus,
  renderSection,
  renderViewTitle,
} from '../primitives';

/** The composer's own slice of the pane's draft, so typing survives a repaint. */
export interface ComposerDraft {
  role: string;
  name: string;
}

/** Where the caller records the live fields, to re-read them before a repaint. */
export interface ComposerLiveInputs {
  // `HTMLElement`, matching the bag the view owns: it records these only to
  // re-read `.value` before a repaint, and narrowing here would force a cast at
  // the one call site for no gain.
  role?: HTMLElement | undefined;
  name?: HTMLElement | undefined;
}

export interface InviteComposerModel {
  readonly role: InvitationRole;
  readonly name: string;
  readonly invitation: { readonly envelope: string; readonly expiresAt: string } | null;
  readonly pending: readonly PendingApprovalEntry[];
  readonly invitationExpired?: boolean;
  readonly notice?: string;
  readonly noticeKind?: 'info' | 'success';
}

export interface InviteComposerActions {
  readonly onClose?: (() => void) | undefined;
  readonly onCreate?:
    | ((role: InvitationRole, name: string, report: (message: string) => void) => void)
    | undefined;
  readonly onCopy?: ((envelope: string) => boolean | Promise<boolean>) | undefined;
  readonly onDismiss?: (() => void) | undefined;
  readonly onApprove?:
    | ((invitationId: string, phrase: string, report: (message: string) => void) => void)
    | undefined;
}

export function renderInviteComposer(
  content: HTMLElement,
  model: InviteComposerModel,
  draft: ComposerDraft,
  live: ComposerLiveInputs,
  actions: InviteComposerActions,
): void {
  const title = content.createDiv();
  title.addClass('havemind-composer-title');
  renderViewTitle(title, 'Invite someone');
  if (actions.onClose !== undefined) {
    const close = title.createEl('button', { text: 'Close' });
    close.addClass('havemind-composer-close');
    close.onClickEvent(() => actions.onClose?.());
  }
  if (model.notice) renderNotice(content, model.notice, model.noticeKind);

  // MAJOR 5: isolate the create and waiting sections so a throw in one degrades
  // to an inline fallback rather than blanking the composer.
  renderSection(content, 'create invitation', () =>
    renderCreateSection(content, model, draft, live, actions),
  );

  // No roster here. The composer carried its own back when it was a separate
  // screen; it now renders inside the People tab, which draws the roster above
  // it, so keeping this drew "Connected / You" twice in one pane.

  renderSection(content, 'waiting devices', () => {
    // Four lines explaining that nothing has happened is the pane talking about
    // itself (round 2, Q4). One quiet line says the same and leaves the space
    // for the device that is about to arrive.
    if (model.pending.length === 0) {
      if (model.invitation !== null) {
        content
          .createDiv({ text: 'Waiting for the other device…' })
          .addClass('havemind-hint');
      }
      return;
    }

    const divider = content.createEl('hr');
    divider.addClass('havemind-divider');
    content.createEl('h4', { text: 'Waiting for the other device' });
    for (const entry of model.pending) {
      renderPendingRow(content, entry, actions);
    }
  });
}

function renderCreateSection(
  content: HTMLElement,
  model: InviteComposerModel,
  draft: ComposerDraft,
  live: ComposerLiveInputs,
  actions: InviteComposerActions,
): void {
  const roleSelect = labelledField(content, 'havemind-invite-role', 'Role', 'select');
  for (const value of ['editor', 'owner'] as const) {
    roleSelect.createEl('option', { text: value, value });
  }
  roleSelect.value = draft.role || model.role;

  const nameInput = labelledField(content, 'havemind-invite-name', 'Name', 'input', {
    type: 'text',
    placeholder: 'e.g. Magda',
    value: draft.name || model.name,
  });
  live.role = roleSelect;
  live.name = nameInput;

  const status = renderFormStatus(content);
  const create = content.createEl('button', { text: 'Create invitation' });
  create.addClass('mod-cta');
  create.onClickEvent(() => {
    const role: InvitationRole = roleSelect.value === 'owner' ? 'owner' : 'editor';
    status.setText('Creating invitation…');
    actions.onCreate?.(role, nameInput.value.trim(), (message) =>
      status.setText(message),
    );
  });

  renderInvitationEnvelope(content, model, actions);
}

/**
 * The composer's transient notice line. 'success' uses the icon+label+colour
 * status-row convention shared with the Connect panel indicator, never colour
 * alone; other notices stay a plain text line.
 */
function renderNotice(
  content: HTMLElement,
  notice: string,
  kind: 'info' | 'success' | undefined,
): void {
  if (kind !== 'success') {
    content.createDiv({ text: notice }).addClass('havemind-hint');
    return;
  }
  const row = content.createDiv({ text: '' });
  row.addClass('havemind-status');
  row.style.setProperty('color', 'var(--text-success)');
  setIcon(row.createEl('span', { attr: DECORATIVE }), 'check-circle');
  row.createEl('span', { text: ` ${notice}` });
}

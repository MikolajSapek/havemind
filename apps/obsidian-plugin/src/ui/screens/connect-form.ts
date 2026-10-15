/**
 * The paste form: an invitation or pairing token, a server URL, and Connect.
 *
 * Extracted from `onboarding-view.ts` for Stage 3. The draft and the live-input
 * handles stay owned by the caller: the pane repaints on every status change,
 * and a half-typed token has to survive that.
 */

import { labelledField, renderFormStatus } from '../primitives';

/** The form's slice of the pane's draft. */
export interface ConnectDraft {
  token: string;
  server: string;
}

/** Where the caller records the live fields, to re-read them before a repaint. */
export interface ConnectLiveInputs {
  token?: HTMLElement | undefined;
  server?: HTMLElement | undefined;
}

export type ConnectReporter = (message: string) => void;

export function renderConnectForm(
  content: HTMLElement,
  draft: ConnectDraft,
  live: ConnectLiveInputs,
  onConnect?: (input: string, serverUrl: string, report: ConnectReporter) => void,
): void {
    const tokenInput = labelledField(
      content,
      'havemind-connect-token',
      'Invitation, or the line from the installer',
      'textarea',
      { placeholder: 'v1.… or hm_pt_…@https://…', value: draft.token },
    );
    // Only a bare pairing token (hm_pt_… without @https://…) lacks the server:
    // an invitation and the installer line carry it, so the field stays hidden.
    const serverField = content.createDiv();
    serverField.addClass('havemind-connect-server-field');
    const serverInput = labelledField(
      serverField,
      'havemind-connect-server',
      'Server URL',
      'input',
      {
        type: 'text',
        placeholder: 'https://… (only if your line has no @)',
        value: draft.server,
      },
    );
    const needsServer = (text: string): boolean => {
      const value = text.trim();
      return value.startsWith('hm_pt_') && !value.includes('@');
    };
    const showServer = (): void => {
      serverField.toggleClass('havemind-is-hidden', !needsServer(tokenInput.value) && draft.server.trim() === '');
    };
    tokenInput.addEventListener('input', showServer);
    showServer();
    live.token = tokenInput;
    live.server = serverInput;
    const status = renderFormStatus(content);
    const connect = content.createEl('button', { text: 'Connect' });
    connect.addClass('mod-cta');
    connect.onClickEvent(() => {
      const input = tokenInput.value.trim();
      const serverUrl = serverInput.value.trim();
      if (input.length === 0) {
        status.setText('Paste an invitation or pairing token first.');
        return;
      }
      status.setText('Connecting…');
      onConnect?.(input, serverUrl, (message) =>
        status.setText(message),
      );
    });
}

/** Everything the pane keeps between repaints, across both forms. */
export interface PaneDraft {
  token: string;
  server: string;
  role: string;
  name: string;
  /** The one-click agent form's picks (plan 015). */
  agentTask?: string;
  agentName?: string;
}

/** Every live field the pane has handed out this render. */
export interface PaneLiveInputs {
  token?: HTMLElement | undefined;
  server?: HTMLElement | undefined;
  role?: HTMLElement | undefined;
  name?: HTMLElement | undefined;
}

/**
 * Reads the live fields back into the draft before the DOM is torn down.
 *
 * A status change can repaint the pane while someone is mid-typing, so without
 * this a re-render silently discards a half-pasted invitation.
 */
export function captureDrafts(draft: PaneDraft, live: PaneLiveInputs): void {
  if (live.token) draft.token = (live.token as HTMLInputElement).value;
  if (live.server) draft.server = (live.server as HTMLInputElement).value;
  if (live.role) {
    const role = (live.role as HTMLSelectElement).value;
    draft.role = role === 'owner' || role === 'agent' ? role : 'editor';
  }
  if (live.name) draft.name = (live.name as HTMLInputElement).value;
}

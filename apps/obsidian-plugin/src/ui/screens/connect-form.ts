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
      'Invitation or owner pairing token',
      'textarea',
      { placeholder: 'v1.… or hm_pt_…', value: draft.token },
    );
    const serverInput = labelledField(
      content,
      'havemind-connect-server',
      'Server URL',
      'input',
      {
        type: 'text',
        placeholder: 'https://your-server.example',
        value: draft.server,
      },
    );
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
    draft.role =
      (live.role as HTMLSelectElement).value === 'owner' ? 'owner' : 'editor';
  }
  if (live.name) draft.name = (live.name as HTMLInputElement).value;
}

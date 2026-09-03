/**
 * The connection status row: a dot or icon, the label, the detail lines, and
 * the one recovery action the current state allows.
 *
 * Extracted from `onboarding-view.ts` for Stage 3. Two rules survive the move.
 * Status is never carried by colour alone: every state pairs its token with a
 * dot or a glyph and a word. And the recovery buttons are state-exclusive:
 * "Retry now" only where a retry can help, "Reset connection" only in
 * `reset-required`, the one state where sync is provably dead, so it can never
 * be an accidental click on a healthy connection.
 */

import { setIcon } from 'obsidian';

import type { ConnectionPanelView } from '../../runtime/status';
import { DECORATIVE } from '../primitives';

export interface StatusIndicatorActions {
  readonly onRetry?: (() => void) | undefined;
  readonly onReset?: (() => void) | undefined;
}

export function renderStatusIndicator(
  content: HTMLElement,
  panel: ConnectionPanelView,
  actions: StatusIndicatorActions = {},
  includeRecovery = true,
): void {
    const row = content.createDiv({ text: '' });
    row.addClass('havemind-status');
    if (panel.spin) row.addClass('havemind-status-spin');
    // synced / conflict read as a small filled dot; the icon name, label and
    // colour token stay exactly as status.ts provides them.
    const isDotStatus = panel.status === 'synced' || panel.status === 'offline';
    row.style.setProperty('color', `var(${panel.colorToken})`);
    if (isDotStatus) {
      const dot = row.createEl('span', { attr: DECORATIVE });
      dot.addClass('havemind-status-dot');
      if (panel.status === 'offline') dot.addClass('havemind-status-dot-idle');
    } else {
      const icon = row.createEl('span', { attr: DECORATIVE });
      setIcon(icon, panel.icon);
    }
    row.createEl('span', { text: ` ${panel.label}` });
    const detail = content.createDiv();
    detail.addClass('havemind-status-detail');
    for (const part of panel.detail.split(' · ')) {
      const line = detail.createEl('span');
      line.addClass('havemind-status-line');
      const lastSync = /^Last sync:\s*(.+)$/.exec(part);
      if (lastSync?.[1] !== undefined) {
        line.appendText('Last sync: ');
        line.createEl('span', { text: lastSync[1] }).addClass('havemind-status-time');
      } else {
        line.setText(part);
      }
    }

    // A "Retry now" affordance for the non-synced backoff/terminal states
    // (offline waiting on the sync runner's backoff, or a terminal
    // reconnect-required). It lets the user force an immediate reconnect rather
    // than waiting the backoff out. Never shown while synced/syncing (nothing to
    // retry) or conflict/disconnected (retry cannot help those). Lives in the
    // panel, not the status bar, since setText clobbers status-bar children.
    if (
      includeRecovery &&
      actions.onRetry !== undefined &&
      (panel.status === 'offline' || panel.status === 'reconnect-required')
    ) {
      const retry = content.createEl('button', { text: 'Retry now' });
      retry.addClass('mod-cta');
      retry.addClass('havemind-retry');
      retry.onClickEvent(() => actions.onRetry?.());
    }

    // P1 #5: the stored connection is damaged, so retrying and rejoining are
    // both dead ends, the one way forward is clearing it and pairing again.
    // Deliberately NOT rendered for any other status: this is the only state in
    // which sync is provably dead, so the button can never be an accidental
    // click on a healthy connection.
    if (
      includeRecovery &&
      actions.onReset !== undefined &&
      panel.status === 'reset-required'
    ) {
      const reset = content.createEl('button', {
        text: 'Reset connection',
        attr: {
          'aria-label':
            'Reset the stored Havemind connection and pair this device again',
        },
      });
      reset.addClass('mod-warning');
      reset.addClass('havemind-reset');
      reset.onClickEvent(() => actions.onReset?.());
    }
}

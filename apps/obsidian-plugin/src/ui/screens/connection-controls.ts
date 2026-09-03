/**
 * The Connect tab: where the connection lives and every action it allows.
 *
 * Extracted from `onboarding-view.ts` for Stage 3. Everything a connection can
 * do is visible in the pane rather than reachable only through the header
 * overflow menu, and changing server stays an explicit two-step action:
 * disconnect first, then the normal pairing form appears. Recovery actions are
 * state-exclusive for the same reason they are in the status row.
 */

import { buildGettingStartedViewModel } from '../../runtime/getting-started-render';
import type { ConnectionPanelView } from '../../runtime/status';
import { renderGettingStarted } from '../getting-started-section';

import { renderStatusIndicator } from './status-indicator';

export interface ConnectionControlsActions {
  readonly onSyncNow?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly onReset?: (() => void) | undefined;
  readonly onDisconnect?: (() => void) | undefined;
  /** Flips the getting-started disclosure; the caller owns the flag. */
  readonly onToggleHelp?: (() => void) | undefined;
}

export function renderConnectionControls(
  content: HTMLElement,
  panel: ConnectionPanelView,
  helpOpen: boolean,
  actions: ConnectionControlsActions,
): void {
    renderStatusIndicator(content, panel, {}, false);

    const state = content.createDiv();
    state.addClass('havemind-connect-block');
    if (panel.serverName !== undefined) {
      const server = state.createDiv();
      server.addClass('havemind-connect-row');
      server.createEl('span', { text: 'Server' }).addClass('havemind-connect-label');
      server
        .createEl('span', { text: panel.serverName })
        .addClass('havemind-connect-value');
    }

    const actionBlock = content.createDiv();
    actionBlock.addClass('havemind-connect-block');
    if (actions.onSyncNow !== undefined) {
      const sync = actionBlock.createEl('button', { text: 'Sync now' });
      sync.addClass('havemind-action-row');
      sync.onClickEvent(() => actions.onSyncNow?.());
    }

    if (
      actions.onRetry !== undefined &&
      (panel.status === 'offline' || panel.status === 'reconnect-required')
    ) {
      const retry = actionBlock.createEl('button', { text: 'Retry now' });
      retry.addClass('havemind-action-row');
      retry.onClickEvent(() => actions.onRetry?.());
    }

    if (actions.onReset !== undefined && panel.status === 'reset-required') {
      const reset = actionBlock.createEl('button', { text: 'Reset connection' });
      reset.addClass('havemind-action-row');
      reset.addClass('mod-warning');
      reset.onClickEvent(() => actions.onReset?.());
    }

    const help = actionBlock.createEl('button', {
      text: helpOpen ? 'Hide getting started' : 'Show getting started',
      attr: { 'aria-expanded': helpOpen ? 'true' : 'false' },
    });
    help.addClass('havemind-action-row');
    help.addClass('mod-quiet');
    help.onClickEvent(() => actions.onToggleHelp?.());

    if (helpOpen) {
      renderGettingStarted(actionBlock, buildGettingStartedViewModel());
    }

    if (actions.onDisconnect !== undefined) {
      const exit = content.createDiv();
      exit.addClass('havemind-connect-block');
      const disconnect = exit.createEl('button', {
        text: 'Disconnect and change server',
      });
      disconnect.addClass('havemind-action-row');
      disconnect.addClass('mod-warning');
      disconnect.onClickEvent(() => actions.onDisconnect?.());
    }
}

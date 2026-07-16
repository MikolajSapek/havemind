/**
 * Status-bar model per `plan/05-plugin-polaczenie-i-sync.md`. Pure formatting so
 * the desktop shell can render a stable label plus a hover tooltip carrying the
 * last-sync time. The tooltip always states that the pilot has no end-to-end
 * encryption — honesty as a feature (`plan/01-zasady-i-slownik.md`).
 */

import type { SyncCycleStatus } from '../sync/sync-runner';

export type ConnectionStatus =
  | 'disconnected'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'conflict'
  | 'reconnect-required';

const LABELS: Readonly<Record<ConnectionStatus, string>> = {
  disconnected: 'disconnected',
  syncing: 'syncing',
  synced: 'Synced',
  offline: 'Offline',
  conflict: 'Conflict',
  'reconnect-required': 'Reconnect required',
};

const NO_E2EE_NOTE = 'Pilot data: no end-to-end encryption.';

/** Maps a completed sync cycle status onto a status-bar connection status. */
export function connectionStatusFromCycle(
  status: SyncCycleStatus,
): ConnectionStatus {
  switch (status) {
    case 'synced':
      return 'synced';
    case 'offline':
      return 'offline';
    case 'conflict':
    case 'deferred':
      return 'conflict';
    case 'unauthenticated':
      return 'reconnect-required';
  }
}

export interface StatusBarInput {
  readonly status: ConnectionStatus;
  readonly lastSyncedAt?: number;
  readonly formatTimestamp?: (timestamp: number) => string;
}

export interface StatusBarView {
  readonly text: string;
  readonly tooltip: string;
}

export function formatStatusBar(input: StatusBarInput): StatusBarView {
  const text = `Havemind: ${LABELS[input.status]}`;
  const format = input.formatTimestamp ?? defaultFormatTimestamp;
  const lastSync =
    input.lastSyncedAt === undefined
      ? 'Last sync: not yet.'
      : `Last sync: ${format(input.lastSyncedAt)}.`;
  return { text, tooltip: `${text} — ${lastSync} ${NO_E2EE_NOTE}` };
}

function defaultFormatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

// ---------------------------------------------------------------------------
// Connect-panel indicator model (F8-02f part C)
// ---------------------------------------------------------------------------

/**
 * A live connection indicator for the Connect panel. Colour is never the only
 * signal (`plan/06`): every state carries a Lucide `icon` name and a text
 * `label` alongside its Obsidian colour token. `showForm` decides whether the
 * paste form (disconnected / reconnect-required) or the connected panel is
 * shown. `spin` is suppressed under reduced motion.
 */
export interface ConnectionPanelInput {
  readonly status: ConnectionStatus;
  readonly serverName?: string;
  readonly lastSyncedAt?: number;
  readonly reducedMotion?: boolean;
  readonly errorMessage?: string;
  readonly formatTimestamp?: (timestamp: number) => string;
}

export interface ConnectionPanelView {
  readonly status: ConnectionStatus;
  /** Lucide icon name — rendered via `setIcon`, never an emoji. */
  readonly icon: string;
  readonly label: string;
  /** Obsidian CSS colour variable (e.g. `--text-success`). */
  readonly colorToken: string;
  /** Whether the spinner should animate (false under reduced motion). */
  readonly spin: boolean;
  /** Show the paste form (true) or the connected panel with Disconnect (false). */
  readonly showForm: boolean;
  readonly detail: string;
}

interface PanelStyle {
  readonly icon: string;
  readonly label: string;
  readonly colorToken: string;
  readonly spin: boolean;
  readonly showForm: boolean;
}

const PANEL_STYLES: Readonly<Record<ConnectionStatus, PanelStyle>> = {
  disconnected: {
    icon: 'circle',
    label: 'Not connected',
    colorToken: '--text-muted',
    spin: false,
    showForm: true,
  },
  syncing: {
    icon: 'loader',
    label: 'Syncing…',
    colorToken: '--text-accent',
    spin: true,
    showForm: false,
  },
  synced: {
    icon: 'check-circle',
    label: 'Connected — synced',
    colorToken: '--text-success',
    spin: false,
    showForm: false,
  },
  offline: {
    icon: 'cloud-off',
    label: 'Offline — will retry',
    colorToken: '--text-warning',
    spin: false,
    showForm: false,
  },
  conflict: {
    icon: 'alert-triangle',
    label: 'Conflict — see Havemind Conflicts',
    colorToken: '--text-warning',
    spin: false,
    showForm: false,
  },
  'reconnect-required': {
    icon: 'alert-triangle',
    label: 'Reconnect required',
    colorToken: '--text-error',
    spin: false,
    showForm: true,
  },
};

export function buildConnectionPanel(
  input: ConnectionPanelInput,
): ConnectionPanelView {
  const style = PANEL_STYLES[input.status];
  const format = input.formatTimestamp ?? defaultFormatTimestamp;
  const parts: string[] = [];
  if (input.serverName !== undefined && input.serverName.length > 0) {
    parts.push(`Server: ${input.serverName}`);
  }
  if (input.status === 'synced' && input.lastSyncedAt !== undefined) {
    parts.push(`Last sync: ${format(input.lastSyncedAt)}`);
  }
  if (input.status === 'reconnect-required' || input.status === 'offline') {
    parts.push(input.errorMessage ?? 'The server refused the session.');
  }
  parts.push(NO_E2EE_NOTE);

  return {
    status: input.status,
    icon: style.icon,
    label: style.label,
    colorToken: style.colorToken,
    spin: style.spin && input.reducedMotion !== true,
    showForm: style.showForm,
    detail: parts.join(' · '),
  };
}

/**
 * Status-bar model per `plan/05-plugin-polaczenie-i-sync.md`. Pure formatting so
 * the desktop shell can render a stable label plus a hover tooltip carrying the
 * last-sync time. The tooltip always states that sync runs over a private
 * Tailscale network only, with no end-to-end encryption — honesty as a feature
 * (`plan/01-zasady-i-slownik.md`).
 */

import type { SyncCycleStatus } from '../sync/sync-runner';

export type ConnectionStatus =
  | 'disconnected'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'conflict'
  | 'reconnect-required'
  /**
   * The persisted connection state is broken — a half-written record, or a
   * structurally valid one whose refresh secret is gone (P1 #5). Distinct from
   * `offline` (the server is unreachable but the pairing is sound) and from
   * `reconnect-required` (the pairing is sound but the session was refused):
   * neither retrying nor rejoining can fix it, so the only way forward is a
   * reset + re-pair. Never derived from a sync cycle; set at connect start.
   */
  | 'reset-required';

const LABELS: Readonly<Record<ConnectionStatus, string>> = {
  disconnected: 'disconnected',
  syncing: 'syncing',
  synced: 'Synced',
  offline: 'Offline',
  conflict: 'Conflict',
  'reconnect-required': 'Reconnect required',
  'reset-required': 'Reset required',
};

/**
 * What the user sees when the persisted connection is unusable. It names the
 * local data as the cause — never the server, which is not at fault — and states
 * the one action that resolves it.
 */
export const RESET_REQUIRED_DETAIL =
  'The stored connection data is incomplete or unreadable. Reset the connection and pair this device again.';

const NO_E2EE_NOTE = 'Private Tailscale network only — no end-to-end encryption.';

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
    icon: 'hexagon',
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
  // The paste form stays available alongside the Reset button: pairing this
  // device afresh overwrites the broken record and is an equally valid way out.
  'reset-required': {
    icon: 'alert-triangle',
    label: 'Connection data damaged',
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
  // A damaged local record is never the server's fault, so it gets its own
  // explanation rather than the session-refused line.
  if (input.status === 'reset-required') {
    parts.push(input.errorMessage ?? RESET_REQUIRED_DETAIL);
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

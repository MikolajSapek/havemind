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
  | 'conflict';

const LABELS: Readonly<Record<ConnectionStatus, string>> = {
  disconnected: 'disconnected',
  syncing: 'syncing',
  synced: 'Synced',
  offline: 'Offline',
  conflict: 'Conflict',
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

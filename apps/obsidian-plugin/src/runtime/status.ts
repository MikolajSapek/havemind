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
  /**
   * A cycle failed and the next attempt is pending, but not enough consecutive
   * failures have accumulated to call the connection lost. Distinct from
   * `syncing`: nothing is progressing, so the indicator must not imply it does.
   * Distinct from `offline`, which is the sustained-failure verdict.
   */
  | 'retrying'
  | 'synced'
  | 'offline'
  | 'conflict'
  /**
   * A remote change is held back because the target note is open with unsaved
   * divergent edits. Nothing was written and no conflict copy exists — the apply
   * simply retries once the buffer settles, so this must never be reported as a
   * conflict.
   */
  | 'deferred'
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

// Sentence case throughout — one convention, so the status bar never mixes
// lowercase and capitalised labels between states.
const LABELS: Readonly<Record<ConnectionStatus, string>> = {
  disconnected: 'Disconnected',
  syncing: 'Syncing',
  retrying: 'Retrying…',
  synced: 'Synced',
  offline: 'Offline',
  conflict: 'Conflict',
  deferred: 'Waiting to apply',
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
const PANE_NETWORK_NOTE = 'Private Tailscale network · Encrypted in transit';

/**
 * What the user sees while a remote change is held back. It says what is
 * happening and that it resolves itself — no conflict copy was written, so it
 * must never send the user to the Conflicts folder.
 */
export const DEFERRED_DETAIL =
  'A change waits for an open note to settle before applying.';

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
      return 'conflict';
    // A deferred apply wrote nothing and produced no conflict copy, so it gets
    // its own waiting state rather than the conflict warning.
    case 'deferred':
      return 'deferred';
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

/**
 * English month abbreviations packed three characters each, indexed by
 * `Date#getMonth()` times three. A fixed table rather than `Intl`: the label is
 * then identical on every machine (ICU renders September as "Sept" under en-GB)
 * and needs no locale data.
 */
const MONTH_ABBREVIATIONS = 'JanFebMarAprMayJunJulAugSepOctNovDec';

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Renders a sync time the way a person reads a clock: `HH:MM` when it happened
 * today, `D MMM, HH:MM` otherwise. Local time, 24-hour, no dependencies. A raw
 * ISO string is precise but unreadable at a glance, and its date half is noise
 * in the common case — a sync minutes ago.
 *
 * `now` is a parameter so the same-day test is deterministic; callers use the
 * `formatTimestamp` injection point on the inputs instead.
 */
function defaultFormatTimestamp(
  timestamp: number,
  now: number = Date.now(),
): string {
  const at = new Date(timestamp);
  const today = new Date(now);
  const clock = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  if (sameDay) {
    return clock;
  }
  const monthStart = at.getMonth() * 3;
  const month = MONTH_ABBREVIATIONS.slice(monthStart, monthStart + 3);
  return `${at.getDate()} ${month}, ${clock}`;
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
  /**
   * The connected server's host, when there is one. Kept out of `detail` so the
   * pane can put it in the overflow menu rather than spending a status line on
   * an address the user already knows (design 1a).
   */
  readonly serverName?: string;
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
    label: 'Connected · syncing',
    colorToken: '--text-accent',
    spin: true,
    showForm: false,
  },
  // A pending retry is not progress: it keeps the warning colour and its own
  // glyph so it is never mistaken for the accent-coloured Syncing state.
  retrying: {
    icon: 'refresh-cw',
    label: 'Retrying…',
    colorToken: '--text-warning',
    spin: true,
    showForm: false,
  },
  synced: {
    icon: 'check-circle',
    label: 'Connected · synced',
    colorToken: '--text-success',
    spin: false,
    showForm: false,
  },
  offline: {
    icon: 'cloud-off',
    label: 'Offline · queued',
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
  // Nothing is wrong and nothing needs doing, so this is muted rather than a
  // warning — and it never mentions the Conflicts folder, which stays empty.
  deferred: {
    icon: 'clock',
    label: 'Waiting to apply',
    colorToken: '--text-muted',
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
    label: 'Not connected',
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
  // The server address is carried separately (see `serverName` below) so the
  // detail line keeps only what changes: recency, the queue, and why a bad
  // state is bad.
  if (input.status === 'synced' && input.lastSyncedAt !== undefined) {
    parts.push(`Last sync: ${format(input.lastSyncedAt)}`);
  }
  if (
    input.status === 'reconnect-required' ||
    input.status === 'offline' ||
    // A pending retry states its reason too, so the panel explains what went
    // wrong before the failures add up to Offline.
    input.status === 'retrying'
  ) {
    parts.push(input.errorMessage ?? 'The server refused the session.');
  }
  if (input.status === 'deferred') {
    parts.push(DEFERRED_DETAIL);
  }
  // A damaged local record is never the server's fault, so it gets its own
  // explanation rather than the session-refused line.
  if (input.status === 'reset-required') {
    parts.push(input.errorMessage ?? RESET_REQUIRED_DETAIL);
  }
  parts.push(PANE_NETWORK_NOTE);

  return {
    status: input.status,
    icon: style.icon,
    label: style.label,
    colorToken: style.colorToken,
    spin: style.spin && input.reducedMotion !== true,
    showForm: style.showForm,
    detail: parts.join(' · '),
    // The pane draws the address in its overflow menu rather than under the
    // status word (design 1a): nobody needs their own server address daily, and
    // in a 300px column it pushed the line that actually changes out of view.
    ...(input.serverName !== undefined && input.serverName.length > 0
      ? { serverName: input.serverName }
      : {}),
  };
}

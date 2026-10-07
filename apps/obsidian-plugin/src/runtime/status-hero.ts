/**
 * The two lines under the flower on the Status tab: the state in one or two
 * words, and one sentence a person can act on. Pure, no DOM.
 */

import type { ConnectionStatus } from './status';

export interface StatusHeroInput {
  readonly status: ConnectionStatus;
  /** `ConnectionPanelView.detail`: carries "Last sync: …" and the error copy. */
  readonly detail: string;
  readonly deviceCount: number;
  /** Outbox items still waiting to go out. */
  readonly waitingCount: number;
  readonly conflictCount: number;
}

export interface StatusHeroText {
  readonly title: string;
  readonly subline: string;
}

const TITLES: Readonly<Record<ConnectionStatus, string>> = {
  synced: 'In sync',
  syncing: 'Syncing',
  retrying: 'Retrying',
  offline: 'Offline',
  conflict: 'Conflict',
  deferred: 'Waiting to apply',
  'reconnect-required': 'Reconnect required',
  'reset-required': 'Reset required',
  disconnected: 'Not connected',
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function lastSync(detail: string): string | null {
  for (const part of detail.split(' · ')) {
    const match = /^Last sync:\s*(.+)$/.exec(part);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function devices(count: number): string | null {
  return count > 0 ? plural(count, 'device', 'devices') : null;
}

export function statusHeroText(input: StatusHeroInput): StatusHeroText {
  const title = TITLES[input.status];
  switch (input.status) {
    case 'synced': {
      const time = lastSync(input.detail);
      const parts = [devices(input.deviceCount), time === null ? null : `last sync ${time}`];
      return { title, subline: parts.filter((p): p is string => p !== null).join(' · ') };
    }
    case 'syncing':
      return { title, subline: devices(input.deviceCount) ?? '' };
    case 'offline':
    case 'retrying': {
      const waiting =
        input.waitingCount > 0
          ? ` ${plural(input.waitingCount, 'change waits', 'changes wait')} here.`
          : '';
      return { title, subline: `This device can't reach the server.${waiting}` };
    }
    case 'conflict':
      return input.conflictCount > 0
        ? { title, subline: `${plural(input.conflictCount, 'note has', 'notes have')} two versions.` }
        : { title, subline: input.detail };
    default:
      return { title, subline: input.detail };
  }
}

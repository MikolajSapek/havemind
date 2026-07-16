import { describe, expect, it } from 'vitest';

import {
  connectionStatusFromCycle,
  formatStatusBar,
  type ConnectionStatus,
} from './status';
import type { SyncCycleStatus } from '../sync/sync-runner';

describe('connectionStatusFromCycle', () => {
  it.each<[SyncCycleStatus, ConnectionStatus]>([
    ['synced', 'synced'],
    ['offline', 'offline'],
    ['conflict', 'conflict'],
    ['deferred', 'conflict'],
  ])('maps cycle %s to connection %s', (cycle, expected) => {
    expect(connectionStatusFromCycle(cycle)).toBe(expected);
  });
});

describe('formatStatusBar', () => {
  it('renders each connection status with a stable label', () => {
    expect(formatStatusBar({ status: 'disconnected' }).text).toBe(
      'Havemind: disconnected',
    );
    expect(formatStatusBar({ status: 'syncing' }).text).toBe('Havemind: syncing');
    expect(formatStatusBar({ status: 'synced' }).text).toBe('Havemind: Synced');
    expect(formatStatusBar({ status: 'offline' }).text).toBe('Havemind: Offline');
    expect(formatStatusBar({ status: 'conflict' }).text).toBe('Havemind: Conflict');
  });

  it('reports the last sync time in the tooltip when known', () => {
    const at = Date.parse('2026-07-16T10:00:00.000Z');
    const bar = formatStatusBar({
      status: 'synced',
      lastSyncedAt: at,
      formatTimestamp: () => '2026-07-16 10:00',
    });
    expect(bar.tooltip).toContain('2026-07-16 10:00');
  });

  it('states that no sync has happened yet when the time is unknown', () => {
    expect(formatStatusBar({ status: 'synced' }).tooltip).toContain('not yet');
  });

  it('flags the pilot has no end-to-end encryption for honesty', () => {
    expect(formatStatusBar({ status: 'synced' }).tooltip.toLowerCase()).toContain(
      'no end-to-end encryption',
    );
  });
});

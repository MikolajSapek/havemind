import { describe, expect, it } from 'vitest';

import {
  buildConnectionPanel,
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
    ['unauthenticated', 'reconnect-required'],
  ])('maps cycle %s to connection %s', (cycle, expected) => {
    expect(connectionStatusFromCycle(cycle)).toBe(expected);
  });
});

describe('buildConnectionPanel', () => {
  it('renders a green connected indicator with icon and text, form hidden', () => {
    const panel = buildConnectionPanel({
      status: 'synced',
      serverName: 'sap.ts.net',
      lastSyncedAt: 0,
      formatTimestamp: () => 'now',
    });
    expect(panel.colorToken).toBe('--text-success');
    expect(panel.icon).toBe('check-circle');
    expect(panel.label).toBe('Connected — synced');
    expect(panel.showForm).toBe(false);
    expect(panel.detail).toContain('sap.ts.net');
    expect(panel.detail).toContain('now');
  });

  it('shows the form when disconnected and when reconnect is required', () => {
    expect(buildConnectionPanel({ status: 'disconnected' }).showForm).toBe(true);
    const reconnect = buildConnectionPanel({ status: 'reconnect-required' });
    expect(reconnect.showForm).toBe(true);
    expect(reconnect.colorToken).toBe('--text-error');
    expect(reconnect.icon).toBe('alert-triangle');
  });

  it('animates the spinner only while syncing and not under reduced motion', () => {
    // The syncing glyph is the hive hexagon (rotated by CSS), not a loader.
    expect(buildConnectionPanel({ status: 'syncing' }).icon).toBe('hexagon');
    expect(buildConnectionPanel({ status: 'syncing' }).spin).toBe(true);
    expect(
      buildConnectionPanel({ status: 'syncing', reducedMotion: true }).spin,
    ).toBe(false);
    expect(buildConnectionPanel({ status: 'synced' }).spin).toBe(false);
  });

  it('never relies on colour alone — always an icon and a label', () => {
    for (const status of [
      'disconnected',
      'syncing',
      'synced',
      'offline',
      'conflict',
      'reconnect-required',
    ] as const) {
      const panel = buildConnectionPanel({ status });
      expect(panel.icon.length).toBeGreaterThan(0);
      expect(panel.label.length).toBeGreaterThan(0);
    }
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

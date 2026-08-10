import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    // A deferred apply is NOT a conflict: nothing was written, no conflict copy
    // exists, so it must never point the user at the Conflicts folder.
    ['deferred', 'deferred'],
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
      'retrying',
      'synced',
      'offline',
      'conflict',
      'deferred',
      'reconnect-required',
      'reset-required',
    ] as const) {
      const panel = buildConnectionPanel({ status });
      expect(panel.icon.length).toBeGreaterThan(0);
      expect(panel.label.length).toBeGreaterThan(0);
    }
  });

  it('warns while retrying instead of claiming progress, and keeps the reason', () => {
    // A failed cycle awaiting its retry is not progress: it gets the warning
    // colour and the offline-style reason, never the accent "Syncing…" look.
    const panel = buildConnectionPanel({
      status: 'retrying',
      errorMessage: 'The server did not answer.',
    });
    expect(panel.icon).toBe('refresh-cw');
    expect(panel.colorToken).toBe('--text-warning');
    expect(panel.spin).toBe(true);
    expect(panel.showForm).toBe(false);
    expect(panel.detail).toContain('The server did not answer.');
    expect(buildConnectionPanel({ status: 'retrying', reducedMotion: true }).spin).toBe(
      false,
    );
  });

  it('explains a deferred apply as waiting, never as a conflict', () => {
    const panel = buildConnectionPanel({ status: 'deferred' });
    expect(panel.icon).toBe('clock');
    expect(panel.colorToken).toBe('--text-muted');
    expect(panel.spin).toBe(false);
    expect(panel.showForm).toBe(false);
    expect(panel.detail).toContain(
      'A change waits for an open note to settle before applying.',
    );
    // No conflict copy exists, so the panel must not send the user looking.
    expect(panel.detail).not.toContain('Havemind Conflicts');
    expect(panel.label).not.toContain('Conflict');
  });
});

describe('formatStatusBar', () => {
  it('renders each connection status with a stable label', () => {
    expect(formatStatusBar({ status: 'disconnected' }).text).toBe(
      'Havemind: Disconnected',
    );
    expect(formatStatusBar({ status: 'syncing' }).text).toBe('Havemind: Syncing');
    expect(formatStatusBar({ status: 'retrying' }).text).toBe('Havemind: Retrying…');
    expect(formatStatusBar({ status: 'synced' }).text).toBe('Havemind: Synced');
    expect(formatStatusBar({ status: 'offline' }).text).toBe('Havemind: Offline');
    expect(formatStatusBar({ status: 'conflict' }).text).toBe('Havemind: Conflict');
    expect(formatStatusBar({ status: 'deferred' }).text).toBe(
      'Havemind: Waiting to apply',
    );
  });

  it('starts every label with a capital — one sentence-case convention', () => {
    for (const status of [
      'disconnected',
      'syncing',
      'retrying',
      'synced',
      'offline',
      'conflict',
      'deferred',
      'reconnect-required',
      'reset-required',
    ] as const) {
      const label = formatStatusBar({ status }).text.replace('Havemind: ', '');
      expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
    }
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

describe('default timestamp format', () => {
  // Fixtures are built from local-time components so the expectations hold in
  // any timezone the suite runs in.
  const NOW = new Date(2026, 6, 16, 18, 30);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows only the clock time for a sync earlier the same day', () => {
    const at = new Date(2026, 6, 16, 9, 5).getTime();
    expect(formatStatusBar({ status: 'synced', lastSyncedAt: at }).tooltip).toContain(
      'Last sync: 09:05.',
    );
  });

  it('adds the day and month for a sync on an earlier day', () => {
    const at = new Date(2026, 6, 4, 21, 7).getTime();
    expect(formatStatusBar({ status: 'synced', lastSyncedAt: at }).tooltip).toContain(
      'Last sync: 4 Jul, 21:07.',
    );
  });

  it('never shows a raw ISO timestamp', () => {
    const at = new Date(2026, 6, 16, 9, 5).getTime();
    expect(
      formatStatusBar({ status: 'synced', lastSyncedAt: at }).tooltip,
    ).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('uses the same human format in the Connect panel', () => {
    const at = new Date(2026, 6, 16, 9, 5).getTime();
    const panel = buildConnectionPanel({ status: 'synced', lastSyncedAt: at });
    expect(panel.detail).toContain('Last sync: 09:05');
    expect(panel.detail).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('still honours an injected formatter', () => {
    const at = new Date(2026, 6, 16, 9, 5).getTime();
    expect(
      formatStatusBar({
        status: 'synced',
        lastSyncedAt: at,
        formatTimestamp: () => 'moments ago',
      }).tooltip,
    ).toContain('moments ago');
  });
});

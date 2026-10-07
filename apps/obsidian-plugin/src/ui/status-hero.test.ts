import { describe, expect, it } from 'vitest';

import { buildConnectionPanel } from '../runtime/status';
import { buildRejoinRosterView } from '../runtime/rejoin-roster';
import type { RosterMember } from '../runtime/roster';
import { flatten, syncedPane } from '../test/dom';
import type { MockElement } from '../test/obsidian.mock';

const members: RosterMember[] = [
  { membershipId: 'm1', displayName: 'Mikołaj Sapek', role: 'owner', self: true },
  { membershipId: 'm2', displayName: 'MIKI IPHONE', role: 'editor', self: false },
  { membershipId: 'm3', displayName: 'Hubert', role: 'editor', self: false },
];

const withClass = (root: MockElement, cls: string): MockElement[] =>
  flatten(root).filter((el) => el.classes.includes(cls));

describe('Status tab', () => {
  it('shows the flower, the state and one line under it', () => {
    const pane = syncedPane({
      panelProvider: () => buildConnectionPanel({ status: 'synced', lastSyncedAt: Date.now() }),
      rejoinRosterProvider: () => buildRejoinRosterView(members),
    });
    const hero = withClass(pane, 'havemind-hero')[0];
    expect(hero).toBeDefined();
    if (hero === undefined) return;
    expect(withClass(hero, 'havemind-flower')).toHaveLength(1);
    expect(withClass(hero, 'havemind-hero-title')[0]?.text).toBe('In sync');
    expect(withClass(hero, 'havemind-hero-sub')[0]?.text).toMatch(/^3 devices · last sync /);
  });

  it('shows a waiting device as a "?" seat, from the pending list, not the composer', () => {
    const pane = syncedPane({
      panelProvider: () => buildConnectionPanel({ status: 'synced', lastSyncedAt: Date.now() }),
      rejoinRosterProvider: () => buildRejoinRosterView(members),
      pendingApprovalsProvider: () => [
        { invitationId: 'i1', expiresAt: new Date(Date.now() + 600_000).toISOString(), intendedMemberDisplayName: 'Magda' },
        { invitationId: 'i2', expiresAt: new Date(Date.now() - 1_000).toISOString() },
      ],
    });
    const labels = withClass(pane, 'havemind-flower-label').map((el) => el.text);
    expect(labels).toEqual(['you', 'H', 'MI', '?']);
  });

  it('offers Retry now when this device is offline', () => {
    const pane = syncedPane({
      panelProvider: () => buildConnectionPanel({ status: 'offline' }),
      rejoinRosterProvider: () => buildRejoinRosterView(members),
      onRetry: () => undefined,
    });
    const hero = withClass(pane, 'havemind-hero')[0];
    expect(hero && withClass(hero, 'havemind-hero-title')[0]?.text).toBe('Offline');
    expect(flatten(pane).some((el) => el.tag === 'button' && el.text === 'Retry now')).toBe(true);
  });
});

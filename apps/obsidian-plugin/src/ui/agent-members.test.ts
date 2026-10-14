/**
 * Plan 014: AI agents are members, shown apart from people. People stay
 * violet; an agent is yellow wherever the pane names it: its seat in the
 * flower, its People row ("AI agent"), and its Activity rows.
 */

import { describe, expect, it } from 'vitest';

import { buildRejoinRosterView } from '../runtime/rejoin-roster';
import type { RosterMember } from '../runtime/roster';
import { buildConnectionPanel } from '../runtime/status';
import { WorkspaceLeaf, type MockElement } from '../test/obsidian.mock';
import { flatten } from '../test/dom';
import { HavemindOnboardingView } from './onboarding-view';
import type { PendingApprovalEntry } from './onboarding-types';

const you: RosterMember = { membershipId: 'm-you', displayName: 'You', role: 'owner', self: true };
const magda: RosterMember = { membershipId: 'm-magda', displayName: 'Magda', role: 'editor', self: false };
const sorter: RosterMember = {
  membershipId: 'm-bot', displayName: 'Inbox sorter', role: 'editor', self: false, kind: 'agent',
};

function feed(actorId: string, displayName: string) {
  return [{
    revisionId: `rev-${actorId}`,
    fileId: `file-${actorId}`,
    path: 'Inbox/note.md',
    kind: 'edit' as const,
    actor: { kind: 'author' as const, actorId, displayName },
    timestamp: 1_000,
    content: null,
  }];
}

function openTab(
  name: RegExp,
  records = [...feed('m-bot', 'Inbox sorter'), ...feed('m-magda', 'Magda')],
  pending: readonly PendingApprovalEntry[] = [],
) {
  const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
    pendingApprovalsProvider: () => pending,
    onOpenComposer: () => undefined,
    panelProvider: () => buildConnectionPanel({ status: 'synced' }),
    activityFeedProvider: () => records,
    rejoinRosterProvider: () => buildRejoinRosterView([sorter, you, magda]),
  });
  view.onOpen();
  const tab = flatten(view.containerEl as unknown as MockElement).find(
    (el) => el.attrs?.['role'] === 'tab' && name.test(el.attrs?.['aria-label'] ?? ''),
  );
  tab?.triggerClick();
  return flatten(view.containerEl as unknown as MockElement);
}

describe('agents in People and Activity (plan 014)', () => {
  it('lists people first, then agents, each agent marked as one', () => {
    const view = buildRejoinRosterView([sorter, you, magda]);
    expect(view.rows.map((row) => [row.displayName, row.agent])).toEqual([
      ['You', false],
      ['Magda', false],
      ['Inbox sorter', true],
    ]);
  });

  it('says "AI agent" on the agent row and marks it for the yellow', () => {
    const els = openTab(/people/i);
    const agentRow = els.find(
      (el) => (el.classes ?? []).includes('havemind-roster-row') && (el.classes ?? []).includes('is-agent'),
    );
    expect(agentRow).toBeDefined();
    const texts = flatten(agentRow as MockElement).map((el) => el.text ?? '');
    expect(texts).toContain('AI agent');
    const people = els.filter(
      (el) => (el.classes ?? []).includes('havemind-roster-row') && !(el.classes ?? []).includes('is-agent'),
    );
    expect(people).toHaveLength(2);
  });

  it('marks what an agent did in Activity, and nothing a person did', () => {
    const rows = openTab(/activity/i).filter((el) => (el.classes ?? []).includes('havemind-activity-row'));
    expect(rows).toHaveLength(2);
    const agentRows = rows.filter((el) => (el.classes ?? []).includes('is-agent'));
    expect(agentRows).toHaveLength(1);
  });

  it('says a waiting device is an AI agent before the owner types its code', () => {
    const els = openTab(/people/i, [], [{
      invitationId: 'inv-1',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      intendedMemberDisplayName: 'Inbox sorter',
      intendedRole: 'editor',
      intendedKind: 'agent',
    }]);
    const meta = els.find((el) => (el.classes ?? []).includes('havemind-pending-meta'));
    expect(meta?.text).toMatch(/^As AI agent · expires in/u);
  });
});

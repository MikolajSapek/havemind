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

describe('inviting an AI agent (plan 014)', () => {
  it('offers "AI agent" as a role and a ready-made task to start from', async () => {
    const { renderInviteComposer } = await import('./screens/invite-composer');
    const { createMockElement } = await import('../test/obsidian.mock');
    const root = createMockElement();
    const created: unknown[][] = [];
    renderInviteComposer(
      root as unknown as HTMLElement,
      { role: 'agent', name: '', invitation: null, pending: [] },
      { role: 'agent', name: '' },
      {},
      { onCreate: (...args: unknown[]) => created.push(args) },
    );
    const els = flatten(root);
    const roles = els.find((el) => el.attrs?.['id'] === 'havemind-invite-role');
    expect(flatten(roles as MockElement).map((el) => el.text)).toContain('AI agent');
    const task = els.find((el) => el.attrs?.['id'] === 'havemind-invite-task');
    expect(flatten(task as MockElement).filter((el) => el.tag === 'option').map((el) => el.text)).toEqual([
      'Inbox sorter',
      'Daily summary',
      'Link gardener',
      'Meeting to tasks',
      'Clip digester',
      'Custom',
    ]);
    els.find((el) => el.text === 'Create invitation')?.triggerClick();
    // No name typed: the agent is named after its task.
    expect(created[0]?.[0]).toBe('agent');
    expect(created[0]?.[1]).toBe('Inbox sorter');
    expect(created[0]?.[3]).toBe('inbox-sorter');
  });
});

describe('adding an agent with one click (plans 015, 016)', () => {
  async function render(model: { keyNeeded: boolean | null; unsupported?: boolean; localPossible?: boolean }) {
    const { renderAddAgent } = await import('./screens/add-agent');
    const { createMockElement } = await import('../test/obsidian.mock');
    const root = createMockElement();
    const added: unknown[][] = [];
    renderAddAgent(root as unknown as HTMLElement, model, {}, {
      onAdd: (...args: unknown[]) => added.push(args),
      onClose: () => undefined,
    });
    const els = () => flatten(root);
    const click = (pred: (el: MockElement) => boolean) => els().find(pred)?.triggerClick();
    return { els, click, added };
  }
  const addButton = (el: MockElement) => el.text === 'Add agent' && el.tag === 'button';

  it('shows every task as a tile with its pixel icon, the first one picked', async () => {
    const { els } = await render({ keyNeeded: false });
    const tiles = els().filter((el) => (el.classes ?? []).includes('havemind-agent-tile'));
    expect(tiles.map((t) => t.attrs?.['data-agent'])).toEqual([
      'inbox-sorter', 'daily-summary', 'link-gardener', 'meeting-to-tasks', 'clip-digester', 'custom',
    ]);
    expect(tiles.every((t) => flatten(t).some((el) => el.tag === 'svg'))).toBe(true);
    expect(tiles[0]?.attrs?.['aria-checked']).toBe('true');
  });

  it('adds the picked task under its own name; a server with a login asks for nothing', async () => {
    const { click, added, els } = await render({ keyNeeded: false });
    expect(els().find((el) => el.attrs?.['id'] === 'havemind-agent-key')).toBeUndefined();
    click((el) => el.attrs?.['data-agent'] === 'daily-summary');
    click(addButton);
    expect(added[0]?.slice(0, 3)).toEqual(['daily-summary', 'Daily summary', null]);
  });

  it('offers the Claude subscription first, with the command to run, and needs its token', async () => {
    const { click, added, els } = await render({ keyNeeded: true });
    expect(els().some((el) => el.text === 'claude setup-token')).toBe(true);
    const field = () => els().find((el) => el.attrs?.['id'] === 'havemind-agent-key') as MockElement;
    expect(field().attrs?.['type']).toBe('password');
    click(addButton);
    expect(added).toHaveLength(0);
    field().value = 'sk-ant-oat01-token';
    click(addButton);
    expect(added[0]?.[2]).toEqual({ kind: 'subscription', secret: 'sk-ant-oat01-token' });
  });

  it('takes an API key instead when chosen', async () => {
    const { click, added, els } = await render({ keyNeeded: true });
    click((el) => el.attrs?.['data-brain'] === 'api-key');
    expect(els().some((el) => el.text === 'claude setup-token')).toBe(false);
    (els().find((el) => el.attrs?.['id'] === 'havemind-agent-key') as MockElement).value = 'sk-ant-api03-key';
    click(addButton);
    expect(added[0]?.[2]).toEqual({ kind: 'api-key', secret: 'sk-ant-api03-key' });
  });

  it('runs on this computer with Claude Code only where that is possible', async () => {
    expect((await render({ keyNeeded: true })).els().some((el) => el.attrs?.['data-brain'] === 'local')).toBe(false);
    const { click, added } = await render({ keyNeeded: true, localPossible: true });
    click((el) => el.attrs?.['data-brain'] === 'local');
    click(addButton);
    expect(added[0]?.[2]).toEqual({ kind: 'local' });
  });

  it('says so plainly on a server that cannot do it', async () => {
    const { els } = await render({ keyNeeded: null, unsupported: true });
    expect(els().some((el) => /cannot add agents with one click/u.test(el.text ?? ''))).toBe(true);
    expect(els().find(addButton)).toBeUndefined();
  });
});

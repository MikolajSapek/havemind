import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentApiForOwner: vi.fn(),
  addAgent: vi.fn(),
  setModelKey: vi.fn(),
  modelKeyConfigured: vi.fn(),
}));

vi.mock('../runtime/obsidian-adapters', () => ({ agentApiForOwner: mocks.agentApiForOwner }));
vi.mock('../runtime/agent-api', () => ({
  addAgent: mocks.addAgent,
  setModelKey: mocks.setModelKey,
  modelKeyConfigured: mocks.modelKeyConfigured,
}));

import type HavemindPlugin from '../main';

import { Agents } from './agents';
import { agentNameProblem } from './agent-name';
import { Invitations } from './invitations';

const API = { fake: 'api' };
const LOGIN = { kind: 'server', provider: 'anthropic', secret: 'sk-ant-api03-x' } as const;

function setup(createFails = false): { agents: Agents; report: Mock<(message: string) => void> } {
  const vault = {
    getAbstractFileByPath: () => null,
    createFolder: vi.fn(async () => undefined),
    create: vi.fn(async () => {
      if (createFails) throw new Error('disk full');
    }),
  };
  const plugin = {
    app: { vault },
    unloaded: false,
    views: { refreshOnboardingNow: vi.fn() },
    people: { rosterMembers: [], refreshRoster: vi.fn() },
  } as unknown as HavemindPlugin;
  return { agents: new Agents(plugin), report: vi.fn<(message: string) => void>() };
}

describe('Agents.add', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.agentApiForOwner.mockResolvedValue(API);
    mocks.addAgent.mockResolvedValue('added');
    mocks.setModelKey.mockResolvedValue('saved');
    // The wait for the agent to show up must never fire inside a test.
    vi.stubGlobal('window', { setTimeout: () => 0 });
  });

  it('adds the agent first and saves the login only after that', async () => {
    const { agents, report } = setup();
    await agents.add('triage', 'Scout', LOGIN, report);
    expect(mocks.addAgent).toHaveBeenCalledBefore(mocks.setModelKey);
    expect(mocks.setModelKey).toHaveBeenCalledOnce();
    expect(agents.notice).toContain('Scout is joining');
  });

  it('saves no login when the name is taken, and when none was given', async () => {
    const taken = setup();
    mocks.addAgent.mockResolvedValue('name-taken');
    await taken.agents.add('triage', 'Scout', LOGIN, taken.report);
    expect(mocks.setModelKey).not.toHaveBeenCalled();
    expect(taken.report).toHaveBeenCalledWith(expect.stringContaining('already called Scout'));

    mocks.addAgent.mockResolvedValue('added');
    const none = setup();
    await none.agents.add('triage', 'Scout', null, none.report);
    expect(mocks.setModelKey).not.toHaveBeenCalled();
  });

  it('reads as one clean sentence when the login was refused (found live: ".).")', async () => {
    const { agents, report } = setup();
    mocks.setModelKey.mockResolvedValue('invalid');
    await agents.add('triage', 'Scout', LOGIN, report);
    const message = report.mock.calls[0]?.[0] ?? '';
    expect(message).toBe('Agent added, but its login was refused: that does not look like an Anthropic API key (sk-ant-api03-…).');
    expect(message).not.toMatch(/\.\)|\.\./u);
  });

  it('says so when the agent was added but its task note could not be written', async () => {
    const { agents, report } = setup(true);
    await agents.add('triage', 'Scout', null, report);
    expect(report).toHaveBeenCalledWith('Agent added, but its task note could not be written.');
    expect(report).not.toHaveBeenCalledWith(expect.stringContaining('Could not reach the server'));
  });

  it('reports an unreachable server, including a failure to get the API', async () => {
    const { agents, report } = setup();
    mocks.agentApiForOwner.mockRejectedValue(new Error('offline'));
    await agents.add('triage', 'Scout', null, report);
    expect(report).toHaveBeenCalledWith('Could not reach the server. Try again in a moment.');
  });

  it('refuses a name that could escape the agents folder, before any request', async () => {
    const { agents, report } = setup();
    for (const bad of ['../x', 'a/b', '.hidden', '', 'x'.repeat(41)]) {
      await agents.add('triage', bad, null, report);
    }
    expect(mocks.agentApiForOwner).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(5);
  });
});

describe('an agent invitation checks the name too', () => {
  it('refuses a path-like name before any request', async () => {
    const report = vi.fn<(message: string) => void>();
    await new Invitations({} as unknown as HavemindPlugin).createInvitation('agent', '../x', report);
    expect(report).toHaveBeenCalledWith(agentNameProblem('../x'));
  });
});

import { describe, expect, it, vi } from 'vitest';

import { buildConnectionPanel } from '../../runtime/status';
import { buildRejoinRosterView } from '../../runtime/rejoin-roster';
import { createContent, flatten } from '../../test/dom';
import { WorkspaceLeaf, type MockElement } from '../../test/obsidian.mock';
import { HavemindOnboardingView } from '../onboarding-view';

import { renderAddAgent, type AddAgentDraft } from './add-agent';
import { clearAgentSecrets } from './add-agent-login';

const noop = { onAdd: vi.fn(), onClose: vi.fn() };
const asEl = (el: MockElement): HTMLElement => el as unknown as HTMLElement;
const byId = (root: MockElement, id: string): MockElement | undefined =>
  flatten(root).find((el) => el.attrs.id === id);

function type(field: MockElement | undefined, value: string, event = 'input'): void {
  if (field === undefined) throw new Error('field missing');
  field.value = value;
  field.triggerEvent(event, {});
}

function pickBrain(root: MockElement, brain: string): void {
  flatten(root).find((el) => el.attrs['data-brain'] === brain)?.triggerClick();
}

describe('Add agent keeps what was typed across a repaint', () => {
  it('the pasted secret', () => {
    const draft: AddAgentDraft = {};
    const first = createContent();
    renderAddAgent(asEl(first), { keyNeeded: true }, draft, noop);
    type(byId(first, 'havemind-agent-key'), 'sk-ant-oat01-abc');

    const second = createContent();
    renderAddAgent(asEl(second), { keyNeeded: true }, draft, noop);

    expect(byId(second, 'havemind-agent-key')?.value).toBe('sk-ant-oat01-abc');
  });

  it('the address, model and service of another model', () => {
    const draft: AddAgentDraft = {};
    const first = createContent();
    renderAddAgent(asEl(first), { keyNeeded: true }, draft, noop);
    pickBrain(first, 'openai-compatible');
    type(byId(first, 'havemind-agent-endpoint'), 'ollama', 'change');
    type(byId(first, 'havemind-agent-base'), 'http://localhost:1234/v1');
    type(byId(first, 'havemind-agent-model'), 'my-model');

    const second = createContent();
    renderAddAgent(asEl(second), { keyNeeded: true }, draft, noop);

    expect(byId(second, 'havemind-agent-base')?.value).toBe('http://localhost:1234/v1');
    expect(byId(second, 'havemind-agent-model')?.value).toBe('my-model');
    expect(byId(second, 'havemind-agent-endpoint')?.value).toBe('ollama');
  });

  it('but picking another brain starts its fields empty', () => {
    const draft: AddAgentDraft = {};
    const root = createContent();
    renderAddAgent(asEl(root), { keyNeeded: true }, draft, noop);
    type(byId(root, 'havemind-agent-key'), 'sk-ant-oat01-abc');
    pickBrain(root, 'anthropic');
    expect(draft.agentSecret ?? '').toBe('');
    expect(byId(root, 'havemind-agent-key')?.value).toBe('');
  });

  it('and clearAgentSecrets forgets all of it', () => {
    const draft: AddAgentDraft = { agentSecret: 's', agentModel: 'm', agentBaseUrl: 'b', agentEndpoint: 'e' };
    clearAgentSecrets(draft);
    expect(draft).toEqual({});
  });

  it('and the pane drops them once the form is closed', () => {
    let model: { keyNeeded: boolean } | null = { keyNeeded: true };
    const view = new HavemindOnboardingView(new WorkspaceLeaf(), {
      panelProvider: () => buildConnectionPanel({ status: 'synced' }),
      rejoinRosterProvider: () =>
        buildRejoinRosterView([{ membershipId: 'm1', displayName: 'You', role: 'owner', self: true }]),
      addAgentProvider: () => model,
      onAddAgent: vi.fn(),
      onOpenAddAgent: vi.fn(),
    });
    void view.onOpen();
    const root = view.containerEl as unknown as MockElement;
    flatten(root).find((el) => el.attrs.role === 'tab' && (el.attrs['aria-label'] ?? '').startsWith('People'))?.triggerClick();
    type(byId(root, 'havemind-agent-key'), 'sk-ant-oat01-abc');
    view.refreshNow();
    expect(byId(root, 'havemind-agent-key')?.value).toBe('sk-ant-oat01-abc');

    model = null;
    view.refreshNow();
    model = { keyNeeded: true };
    view.refreshNow();

    expect(byId(root, 'havemind-agent-key')?.value).toBe('');
  });
});

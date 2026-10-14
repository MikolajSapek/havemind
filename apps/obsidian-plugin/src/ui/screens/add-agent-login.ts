/**
 * "How it thinks" in Add agent (plan 016): the Claude subscription (a token
 * from `claude setup-token`), an API key, or Claude Code on this computer.
 * Shows only what the chosen way needs.
 */

import { labelledField } from '../primitives';

import type { AddAgentDraft, AddAgentModel, AgentBrain } from './add-agent';

const SETUP_TOKEN_COMMAND = 'claude setup-token';

const BRAINS: readonly { id: AgentBrain; title: string; detail: string }[] = [
  { id: 'subscription', title: 'Claude subscription', detail: 'Runs on your server, day and night.' },
  { id: 'api-key', title: 'API key', detail: 'Runs on your server, billed to the key.' },
  { id: 'local', title: 'Claude Code here', detail: 'Runs on this computer while Obsidian is open.' },
];

export function renderBrains(
  content: HTMLElement,
  model: AddAgentModel,
  draft: AddAgentDraft,
): () => { brain: AgentBrain; secret: () => string } {
  content.createDiv({ text: 'How it thinks' }).addClass('havemind-agent-section');
  const choices = BRAINS.filter((choice) => choice.id !== 'local' || model.localPossible === true);
  draft.agentBrain ??= 'subscription';
  const group = content.createEl('div', { attr: { role: 'radiogroup', 'aria-label': 'How the agent thinks' } });
  group.addClass('havemind-agent-brains');
  const detail = content.createDiv();
  detail.addClass('havemind-agent-brain-detail');
  let secret: (HTMLElement & { value: string }) | null = null;

  const drawDetail = (): void => {
    detail.empty();
    secret = null;
    if (draft.agentBrain === 'local') {
      detail.createDiv({ text: 'Uses the Claude Code you are signed in to on this computer. Nothing to paste.' }).addClass('havemind-hint');
      return;
    }
    if (draft.agentBrain === 'subscription') {
      detail.createDiv({ text: 'In Terminal, run this once and paste what it prints:' }).addClass('havemind-hint');
      detail.createEl('code', { text: SETUP_TOKEN_COMMAND, cls: 'havemind-host-command' });
    }
    secret = labelledField(
      detail,
      'havemind-agent-key',
      draft.agentBrain === 'subscription' ? 'Token from Claude Code' : 'Anthropic API key',
      'input',
      { type: 'password', placeholder: draft.agentBrain === 'subscription' ? 'sk-ant-oat01-…' : 'sk-ant-api03-…' },
    ) as HTMLElement & { value: string };
    secret.setAttribute('type', 'password');
    secret.setAttribute('autocomplete', 'off');
    detail.createDiv({ text: 'Sent once to your server and kept there; never shown again.' }).addClass('havemind-hint');
  };

  const buttons: HTMLElement[] = [];
  for (const choice of choices) {
    const button = group.createEl('button', {
      attr: { role: 'radio', 'aria-checked': String(choice.id === draft.agentBrain), 'data-brain': choice.id },
    });
    button.addClass('havemind-agent-brain');
    if (choice.id === draft.agentBrain) button.addClass('is-selected');
    button.createDiv({ text: choice.title }).addClass('havemind-agent-brain-title');
    button.createDiv({ text: choice.detail }).addClass('havemind-agent-brain-sub');
    button.onClickEvent(() => {
      draft.agentBrain = choice.id;
      for (const other of buttons) {
        const on = other === button;
        other.toggleClass('is-selected', on);
        other.setAttribute('aria-checked', String(on));
      }
      drawDetail();
    });
    buttons.push(button);
  }
  drawDetail();
  return () => ({ brain: draft.agentBrain ?? 'subscription', secret: () => secret?.value.trim() ?? '' });
}

/**
 * "How it thinks" in Add agent (plan 016): the owner picks a provider; each
 * shows only what it needs. Claude and Codex use the subscription the owner
 * already pays for, through their own CLI's login; an Anthropic key uses the
 * API; "Other models" is any OpenAI-compatible endpoint (OpenAI, OpenRouter,
 * Gemini, a local Ollama...). Secrets are typed into password fields and
 * leave this form only towards the owner's server.
 */

import { labelledField } from '../primitives';

import type { AddAgentDraft, AddAgentModel } from './add-agent';

export type AgentBrain = 'claude-code' | 'codex' | 'anthropic' | 'openai-compatible' | 'local';

interface Choice {
  readonly id: AgentBrain;
  readonly title: string;
  readonly detail: string;
}

const CHOICES: readonly Choice[] = [
  { id: 'claude-code', title: 'Claude', detail: 'Your Claude subscription' },
  { id: 'codex', title: 'Codex', detail: 'Your ChatGPT subscription' },
  { id: 'anthropic', title: 'Anthropic API', detail: 'Billed to an API key' },
  { id: 'openai-compatible', title: 'Other models', detail: 'OpenAI, OpenRouter, Gemini, Ollama' },
  { id: 'local', title: 'This computer', detail: 'Claude Code, Codex or Cursor here' },
];

/** OpenAI-compatible endpoints people use most; any other URL works too. */
export const ENDPOINTS: readonly { id: string; title: string; baseUrl: string; model: string }[] = [
  { id: 'openrouter', title: 'OpenRouter (any model)', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' },
  { id: 'openai', title: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
  { id: 'gemini', title: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro' },
  { id: 'ollama', title: 'Ollama on the server', baseUrl: 'http://host.docker.internal:11434/v1', model: 'llama3.1' },
];

export interface BrainInput {
  readonly brain: AgentBrain;
  readonly secret: string;
  readonly model: string;
  readonly baseUrl: string;
}

type Field = HTMLElement & { value: string };

function secretField(parent: HTMLElement, label: string, placeholder: string): Field {
  const field = labelledField(parent, 'havemind-agent-key', label, 'input', { type: 'password', placeholder }) as Field;
  field.setAttribute('type', 'password');
  field.setAttribute('autocomplete', 'off');
  return field;
}

function command(parent: HTMLElement, lead: string, text: string): void {
  parent.createDiv({ text: lead }).addClass('havemind-hint');
  parent.createEl('code', { text, cls: 'havemind-host-command' });
}

export function renderBrains(content: HTMLElement, model: AddAgentModel, draft: AddAgentDraft): () => BrainInput {
  content.createDiv({ text: 'How it thinks' }).addClass('havemind-agent-section');
  const choices = CHOICES.filter((choice) => choice.id !== 'local' || model.localPossible === true);
  draft.agentBrain ??= 'claude-code';
  const group = content.createEl('div', { attr: { role: 'radiogroup', 'aria-label': 'How the agent thinks' } });
  group.addClass('havemind-agent-brains');
  const detail = content.createDiv();
  detail.addClass('havemind-agent-brain-detail');
  const fields: { secret?: Field; model?: Field; baseUrl?: Field } = {};

  const drawDetail = (): void => {
    detail.empty();
    delete fields.secret;
    delete fields.model;
    delete fields.baseUrl;
    switch (draft.agentBrain) {
      case 'local':
        detail.createDiv({ text: 'Runs here while Obsidian is open, with the Claude Code, Codex or Cursor you are signed in to. Nothing to paste.' }).addClass('havemind-hint');
        return;
      case 'claude-code':
        command(detail, 'In Terminal, run this once and paste what it prints:', 'claude setup-token');
        fields.secret = secretField(detail, 'Token', 'sk-ant-oat01-…');
        break;
      case 'codex':
        command(detail, 'Signed in to Codex on this computer? Copy its login:', 'cat ~/.codex/auth.json | pbcopy');
        fields.secret = secretField(detail, 'Codex login (auth.json)', '{"tokens": …}');
        break;
      case 'anthropic':
        fields.secret = secretField(detail, 'Anthropic API key', 'sk-ant-api03-…');
        break;
      case 'openai-compatible': {
        const endpoint = labelledField(detail, 'havemind-agent-endpoint', 'Service', 'select') as Field;
        for (const option of ENDPOINTS) endpoint.createEl('option', { text: option.title, value: option.id });
        const first = ENDPOINTS[0];
        fields.baseUrl = labelledField(detail, 'havemind-agent-base', 'Address', 'input', { type: 'text', value: first?.baseUrl ?? '' }) as Field;
        fields.model = labelledField(detail, 'havemind-agent-model', 'Model', 'input', { type: 'text', value: first?.model ?? '' }) as Field;
        fields.secret = secretField(detail, 'API key (none for Ollama)', 'sk-…');
        endpoint.addEventListener('change', () => {
          const picked = ENDPOINTS.find((option) => option.id === endpoint.value);
          if (picked === undefined) return;
          if (fields.baseUrl !== undefined) fields.baseUrl.value = picked.baseUrl;
          if (fields.model !== undefined) fields.model.value = picked.model;
        });
        break;
      }
      default:
        break;
    }
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
  return () => ({
    brain: draft.agentBrain ?? 'claude-code',
    secret: fields.secret?.value.trim() ?? '',
    model: fields.model?.value.trim() ?? '',
    baseUrl: fields.baseUrl?.value.trim() ?? '',
  });
}

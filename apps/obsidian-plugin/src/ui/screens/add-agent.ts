/**
 * Add an AI agent with one click (plans 015, 016): pick what it does from a
 * grid of tiles, optionally name it, and, the first time only, choose how it
 * thinks: your Claude subscription or an API key (it then runs on the server,
 * day and night), or Claude Code on this computer (while Obsidian is open).
 * No invitation, no command, no six digits.
 */

import { AGENT_PRESETS, CUSTOM_AGENT, presetById, type AgentPreset } from '../../runtime/agent-presets';
import { renderAgentIcon } from '../agent-icon';
import { labelledField, renderFormStatus, renderViewTitle } from '../primitives';

import { renderBrains, type AgentBrain } from './add-agent-login';

export type { AgentBrain };


export interface AddAgentModel {
  /** True: ask how it thinks; false: the server already has a login; null: checking. */
  readonly keyNeeded: boolean | null;
  /** This server cannot add agents with one click. */
  readonly unsupported?: boolean;
  /** Claude Code on this computer is possible (desktop Obsidian). */
  readonly localPossible?: boolean;
}

export interface AddAgentDraft {
  agentTask?: string;
  agentName?: string;
  agentBrain?: AgentBrain;
}

/** What the agent thinks with, as the owner chose it; null keeps the server's brain. */
export type AgentLogin =
  | {
      readonly kind: 'server';
      readonly provider: 'claude-code' | 'codex' | 'anthropic' | 'openai-compatible';
      readonly secret?: string;
      readonly model?: string;
      readonly baseUrl?: string;
    }
  | { readonly kind: 'local' }
  | null;

const MISSING: Readonly<Record<string, string>> = {
  'claude-code': 'Paste the token from claude setup-token first.',
  codex: 'Paste your Codex login (auth.json) first.',
  anthropic: 'Paste the API key first.',
  'openai-compatible': 'Give the address and the model first.',
};

export interface AddAgentActions {
  readonly onAdd: (presetId: string, name: string, login: AgentLogin, report: (message: string) => void) => void;
  readonly onClose: () => void;
}

function renderTiles(content: HTMLElement, draft: AddAgentDraft, onPick: (preset: AgentPreset) => void): void {
  const grid = content.createEl('div', { attr: { role: 'radiogroup', 'aria-label': 'What the agent does' } });
  grid.addClass('havemind-agent-tiles');
  const chosen = draft.agentTask ?? AGENT_PRESETS[0]?.id ?? CUSTOM_AGENT.id;
  const tiles: HTMLElement[] = [];
  for (const preset of [...AGENT_PRESETS, CUSTOM_AGENT]) {
    const tile = grid.createEl('button', {
      attr: { role: 'radio', 'aria-checked': String(preset.id === chosen), 'data-agent': preset.id },
    });
    tile.addClass('havemind-agent-tile');
    if (preset.id === chosen) tile.addClass('is-selected');
    const badge = tile.createDiv();
    badge.addClass('havemind-agent-badge');
    renderAgentIcon(badge, preset === CUSTOM_AGENT ? 'robot' : preset.id, 'havemind-agent-badge-icon');
    const copy = tile.createDiv();
    copy.addClass('havemind-agent-tile-copy');
    copy.createDiv({ text: preset === CUSTOM_AGENT ? 'Custom' : preset.name }).addClass('havemind-agent-tile-name');
    copy.createDiv({ text: preset.summary }).addClass('havemind-agent-tile-summary');
    tile.onClickEvent(() => {
      draft.agentTask = preset.id;
      for (const other of tiles) {
        const on = other === tile;
        other.toggleClass('is-selected', on);
        other.setAttribute('aria-checked', String(on));
      }
      onPick(preset);
    });
    tiles.push(tile);
  }
}

export function renderAddAgent(
  content: HTMLElement,
  model: AddAgentModel,
  draft: AddAgentDraft,
  actions: AddAgentActions,
): void {
  const title = content.createDiv();
  title.addClass('havemind-composer-title');
  renderViewTitle(title, 'Add an AI agent');
  const close = title.createEl('button', { text: 'Close' });
  close.addClass('havemind-composer-close');
  close.onClickEvent(() => actions.onClose());

  if (model.unsupported === true) {
    content
      .createDiv({
        text: 'This server cannot add agents with one click yet. Update it by running the installer again, or use Invite someone with the role AI agent.',
      })
      .addClass('havemind-hint');
    return;
  }

  const nameRef: { el?: HTMLElement } = {};
  renderTiles(content, draft, (preset) => {
    nameRef.el?.setAttribute('placeholder', preset === CUSTOM_AGENT ? 'Agent' : preset.name);
  });
  const current = presetById(draft.agentTask ?? AGENT_PRESETS[0]?.id ?? CUSTOM_AGENT.id);
  const name = labelledField(content, 'havemind-agent-name', 'Name', 'input', {
    type: 'text',
    placeholder: current === CUSTOM_AGENT ? 'Agent' : current.name,
    value: draft.agentName ?? '',
  }) as HTMLElement & { value: string };
  nameRef.el = name;
  name.addEventListener('input', () => {
    draft.agentName = name.value;
  });

  const brain = model.keyNeeded === true ? renderBrains(content, model, draft) : null;
  if (model.keyNeeded === false) {
    content.createDiv({ text: 'Thinks with the Claude login already on your server.' }).addClass('havemind-hint');
  }

  const status = renderFormStatus(content);
  const add = content.createEl('button', { text: 'Add agent' });
  add.addClass('mod-cta');
  add.addClass('havemind-agent-add');
  add.onClickEvent(() => {
    const preset = presetById(draft.agentTask ?? AGENT_PRESETS[0]?.id ?? CUSTOM_AGENT.id);
    let login: AgentLogin = null;
    if (brain !== null) {
      const picked = brain();
      if (picked.brain === 'local') {
        login = { kind: 'local' };
      } else {
        const open = picked.brain === 'openai-compatible';
        if (open ? picked.baseUrl === '' || picked.model === '' : picked.secret === '') {
          status.setText(MISSING[picked.brain] ?? 'Fill in the login first.');
          return;
        }
        login = {
          kind: 'server',
          provider: picked.brain,
          ...(picked.secret === '' ? {} : { secret: picked.secret }),
          ...(open ? { model: picked.model, baseUrl: picked.baseUrl } : {}),
        };
      }
    }
    status.setText('Adding…');
    actions.onAdd(preset.id, name.value.trim() || preset.name, login, (message) => status.setText(message));
  });
}

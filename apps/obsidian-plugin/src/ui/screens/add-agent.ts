/**
 * Add an AI agent with one click (plan 015): pick a task, optionally a name,
 * and, the first time only, the model key. The agents service on the server
 * does the rest; no invitation, no command, no six digits.
 */

import { AGENT_PRESETS, CUSTOM_AGENT, presetById } from '../../runtime/agent-presets';
import { labelledField, renderFormStatus, renderViewTitle } from '../primitives';

export interface AddAgentModel {
  /** True: ask for the key; false: the server has one; null: still checking. */
  readonly keyNeeded: boolean | null;
  /** This server cannot add agents with one click. */
  readonly unsupported?: boolean;
}

export interface AddAgentDraft {
  agentTask?: string;
  agentName?: string;
}

export interface AddAgentActions {
  readonly onAdd: (presetId: string, name: string, key: string | null, report: (message: string) => void) => void;
  readonly onClose: () => void;
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

  const task = labelledField(content, 'havemind-agent-task', 'Task', 'select') as HTMLElement & { value: string };
  for (const preset of [...AGENT_PRESETS, CUSTOM_AGENT]) {
    task.createEl('option', { text: preset === CUSTOM_AGENT ? 'Custom' : preset.name, value: preset.id });
  }
  task.value = draft.agentTask ?? AGENT_PRESETS[0]?.id ?? CUSTOM_AGENT.id;
  const summary = content.createDiv({ text: presetById(task.value).summary });
  summary.addClass('havemind-hint');
  task.addEventListener('change', () => {
    draft.agentTask = task.value;
    summary.setText(presetById(task.value).summary);
  });

  const name = labelledField(content, 'havemind-agent-name', 'Name', 'input', {
    type: 'text',
    placeholder: 'Same as the task',
    value: draft.agentName ?? '',
  }) as HTMLElement & { value: string };
  name.addEventListener('input', () => {
    draft.agentName = name.value;
  });

  // The key is asked once per server, never kept in the pane's draft.
  const key =
    model.keyNeeded === true
      ? (labelledField(content, 'havemind-agent-key', 'Anthropic API key (once; it stays on your server)', 'input', {
          type: 'password',
          placeholder: 'sk-ant-…',
        }) as HTMLElement & { value: string })
      : null;
  key?.setAttribute('type', 'password');
  key?.setAttribute('autocomplete', 'off');

  const status = renderFormStatus(content);
  const add = content.createEl('button', { text: 'Add agent' });
  add.addClass('mod-cta');
  add.onClickEvent(() => {
    const preset = presetById(task.value);
    const keyValue = key?.value.trim() ?? '';
    if (key !== null && keyValue === '') {
      status.setText('Paste the API key first; the agent needs it to work.');
      return;
    }
    status.setText('Adding…');
    actions.onAdd(preset.id, name.value.trim() || preset.name, key === null ? null : keyValue, (message) =>
      status.setText(message),
    );
  });
  content
    .createDiv({ text: 'It works in the background and appears in yellow within a minute.' })
    .addClass('havemind-hint');
}

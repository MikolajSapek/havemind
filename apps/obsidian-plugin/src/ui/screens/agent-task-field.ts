/**
 * The "Task" picker the invite composer shows when the role is "AI agent"
 * (plan 014): a ready-made background agent to start from, or Custom.
 */

import { AGENT_PRESETS, CUSTOM_AGENT, presetById, type AgentPreset } from '../../runtime/agent-presets';
import { labelledField } from '../primitives';

/** Renders the picker; returns the chosen preset, read at Create time. */
export function renderAgentTaskField(
  content: HTMLElement,
  roleSelect: HTMLElement & { value: string },
  draft: { role: string; task?: string },
): () => AgentPreset {
  const box = content.createDiv();
  const select = labelledField(box, 'havemind-invite-task', 'Task', 'select') as HTMLElement & { value: string };
  for (const preset of [...AGENT_PRESETS, CUSTOM_AGENT]) {
    select.createEl('option', { text: preset === CUSTOM_AGENT ? 'Custom' : preset.name, value: preset.id });
  }
  select.value = draft.task ?? AGENT_PRESETS[0]?.id ?? CUSTOM_AGENT.id;
  const show = (): void => {
    box.style.setProperty('display', roleSelect.value === 'agent' ? '' : 'none');
  };
  show();
  roleSelect.addEventListener('change', () => {
    draft.role = roleSelect.value;
    show();
  });
  select.addEventListener('change', () => {
    draft.task = select.value;
  });
  return () => presetById(select.value || (AGENT_PRESETS[0]?.id ?? CUSTOM_AGENT.id));
}

import { describe, expect, it } from 'vitest';

import { checkWrite, parseTaskNote } from '../headless/task-note';
import { AGENT_PRESETS, CUSTOM_AGENT, presetById, taskNoteFor } from './agent-presets';

describe('ready-made agents (plan 014)', () => {
  it('offers the five background agents', () => {
    expect(AGENT_PRESETS.map((preset) => preset.name)).toEqual([
      'Inbox sorter',
      'Daily summary',
      'Link gardener',
      'Meeting to tasks',
      'Clip digester',
    ]);
  });

  it('writes task notes the agent reads back exactly', () => {
    for (const preset of [...AGENT_PRESETS, CUSTOM_AGENT]) {
      const task = parseTaskNote(taskNoteFor(preset));
      expect(task.mayWrite).toEqual(preset.mayWrite);
      expect(task.instructions).toBe(preset.instructions);
      expect(task.everyMinutes).toBeGreaterThan(0);
    }
  });

  it('gives every preset a folder it may write in, and none can reach the task notes', () => {
    for (const preset of AGENT_PRESETS) {
      const task = parseTaskNote(taskNoteFor(preset));
      expect(checkWrite(`${preset.mayWrite[0]}/x.md`, task)).toBeNull();
      expect(checkWrite(`Havemind/Agents/${preset.name}.md`, task)).toMatch(/never/u);
    }
  });

  it('tells the Inbox sorter to add only tags a note lacks, on its existing tag line (plan 018 item 26)', () => {
    const sorter = presetById('inbox-sorter').instructions;
    expect(sorter).toMatch(/only tags the note does not already have/u);
    expect(sorter).toMatch(/existing tag line/u);
    expect(sorter).not.toMatch(/with a line of tags at the end/u);
  });

  it('falls back to a custom agent with no folder until the owner names one', () => {
    expect(presetById('nope')).toBe(CUSTOM_AGENT);
    expect(parseTaskNote(taskNoteFor(CUSTOM_AGENT)).mayWrite).toEqual([]);
  });
});

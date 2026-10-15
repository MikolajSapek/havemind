import { describe, expect, it } from 'vitest';

import { AGENTS_FOLDER, checkWrite, parseTaskNote, taskNotePath } from './task-note';

const NOTE = `---
may_write: [Inbox, "Notes/Filed"]
every: 30m
---
Sort every note in Inbox/ into a folder under Notes/Filed.
`;

describe('an agent task note (plan 014)', () => {
  it('lives in Havemind/Agents under the agent name', () => {
    expect(taskNotePath('Inbox sorter')).toBe(`${AGENTS_FOLDER}/Inbox sorter.md`);
  });

  it('reads the folders, the schedule and the instructions', () => {
    expect(parseTaskNote(NOTE)).toEqual({
      mayWrite: ['Inbox', 'Notes/Filed'],
      everyMinutes: 30,
      instructions: 'Sort every note in Inbox/ into a folder under Notes/Filed.',
    });
  });

  it('accepts a YAML list, hours and days, and defaults to hourly', () => {
    const task = parseTaskNote('---\nmay_write:\n  - Summaries\n  - Daily\nevery: 1d\n---\nWrite a summary.');
    expect(task.mayWrite).toEqual(['Summaries', 'Daily']);
    expect(task.everyMinutes).toBe(24 * 60);
    expect(parseTaskNote('---\nevery: 2h\n---\nx').everyMinutes).toBe(120);
    expect(parseTaskNote('No frontmatter at all.').everyMinutes).toBe(60);
  });

  it('may write nowhere when the note names no folder', () => {
    expect(parseTaskNote('Just instructions.').mayWrite).toEqual([]);
  });
});

describe('where an agent may write', () => {
  const task = parseTaskNote(NOTE);

  it('allows its own folders and anything below them', () => {
    expect(checkWrite('Inbox/a.md', task)).toBeNull();
    expect(checkWrite('Notes/Filed/Work/b.md', task)).toBeNull();
  });

  it('refuses everything else, with the reason', () => {
    expect(checkWrite('Notes/other.md', task)).toMatch(/outside Inbox, Notes\/Filed/u);
    expect(checkWrite('Inboxes/x.md', task)).toMatch(/outside/u);
    expect(checkWrite('top.md', task)).toMatch(/outside/u);
  });

  it('never lets an agent touch task notes, settings, conflicts or trash, whatever its note says', () => {
    // A note in Inbox/ must never talk the agent into widening its own scope.
    const greedy = parseTaskNote('---\nmay_write: ["", Havemind, .obsidian, Havemind Conflicts, .trash, /]\n---\nx');
    for (const path of [
      'Havemind/Agents/Inbox sorter.md',
      '.obsidian/appearance.json',
      'Havemind Conflicts/a.md',
      '.trash/a.md',
    ]) {
      expect(checkWrite(path, greedy)).toMatch(/never/u);
    }
  });

  it('refuses a path that climbs out with ..', () => {
    expect(checkWrite('Inbox/../top.md', task)).toMatch(/never/u);
  });

  it('compares the never-list case-folded and NFC, as macOS peers see the folders (plan 018 item 10)', () => {
    const greedy = parseTaskNote('---\nmay_write: [havemind/agents, .Obsidian, HAVEMIND CONFLICTS, .TRASH, Notes]\n---\nx');
    for (const path of [
      'havemind/agents/Bot.md',
      'HAVEMIND/Agents/Bot.md',
      '.Obsidian/appearance.json',
      'havemind conflicts/a.md',
      '.Trash/a.md',
    ]) {
      expect(checkWrite(path, greedy)).toMatch(/never/u);
    }
    expect(checkWrite('Notes/ok.md', greedy)).toBeNull();
  });

  it('refuses segments ending in a dot or a space, which Windows and macOS peers fold', () => {
    const task = parseTaskNote('---\nmay_write: [Notes]\n---\nx');
    for (const path of ['Notes/Havemind./a.md', 'Notes/a /b.md', 'Notes/b.md ', 'Notes/x./y.md']) {
      expect(checkWrite(path, task)).toMatch(/never/u);
    }
    expect(checkWrite('Havemind./Agents/a.md', parseTaskNote('---\nmay_write: [Havemind.]\n---\nx'))).toMatch(/never/u);
  });
});

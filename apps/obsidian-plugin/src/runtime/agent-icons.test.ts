import { describe, expect, it } from 'vitest';

import { AGENT_ICONS, DEFAULT_AGENT_ICON, ICON_SIZE, iconForTaskNote, iconPixels } from './agent-icons';
import { AGENT_PRESETS, taskNoteFor } from './agent-presets';

describe('pixel icons for agents (plan 016)', () => {
  it('draws every icon on a 12 by 12 grid', () => {
    for (const [id, rows] of Object.entries(AGENT_ICONS)) {
      expect(rows, id).toHaveLength(ICON_SIZE);
      for (const row of rows) expect(row, id).toMatch(/^[#.]{12}$/u);
    }
  });

  it('has one for every ready-made agent, and its task note names it', () => {
    for (const preset of AGENT_PRESETS) {
      expect(AGENT_ICONS[preset.id], preset.id).toBeDefined();
      expect(iconForTaskNote(taskNoteFor(preset))).toBe(preset.id);
    }
  });

  it('falls back to the robot for a custom or unknown icon', () => {
    expect(iconForTaskNote(null)).toBe(DEFAULT_AGENT_ICON);
    expect(iconForTaskNote('---\nicon: nonsense\n---\nx')).toBe(DEFAULT_AGENT_ICON);
    expect(iconForTaskNote('No frontmatter, icon: inbox-sorter')).toBe(DEFAULT_AGENT_ICON);
  });

  it('turns a drawing into pixels', () => {
    expect(iconPixels('robot')).toContainEqual([5, 0]);
    expect(iconPixels('robot').every(([x, y]) => x < ICON_SIZE && y < ICON_SIZE)).toBe(true);
  });
});

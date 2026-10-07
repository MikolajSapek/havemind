import { describe, expect, it } from 'vitest';

import { buildEntryChooser } from '../runtime/entry-choice';
import { asEl, createContent, flatten } from '../test/dom';

import { renderEntryChooser } from './entry-chooser-section';

describe('entry chooser (plan 010)', () => {
  it('shows the empty flower, one sentence and the two ways in, the first one primary', () => {
    const content = createContent();
    renderEntryChooser(asEl(content), { model: buildEntryChooser(), onChoose: () => undefined });
    const all = flatten(content);
    const flower = all.find((el) => el.classes.includes('havemind-flower'));
    expect(flower?.attrs['aria-label']).toBe('Not connected yet.');
    expect(all.some((el) => el.classes.includes('havemind-pane-mark'))).toBe(false);
    expect(all.find((el) => el.classes.includes('havemind-entry-title'))?.text).toBe(
      'One shared vault, on your hardware.',
    );
    const options = all.filter((el) => el.classes.includes('havemind-entry-option'));
    expect(options.map((el) => el.text)).toEqual(['Someone sent me an invitation', "I'll run the server"]);
    expect(options[0]?.classes).toContain('mod-cta');
    expect(options[1]?.classes).not.toContain('mod-cta');
  });

  it('on a phone offers the invitation only', () => {
    const content = createContent();
    renderEntryChooser(asEl(content), { model: buildEntryChooser({ canHost: false }), onChoose: () => undefined });
    const options = flatten(content).filter((el) => el.classes.includes('havemind-entry-option'));
    expect(options.map((el) => el.text)).toEqual(['Someone sent me an invitation']);
  });
});

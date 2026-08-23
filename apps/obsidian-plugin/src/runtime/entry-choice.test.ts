import { describe, expect, it } from 'vitest';

import {
  SELF_HOSTING_GUIDE_URL,
  buildEntryChooser,
  buildHostView,
} from './entry-choice';

describe('entry chooser', () => {
  it('puts the invitation path first', () => {
    // Roughly half of users are joining, and theirs is the cheaper path. Making
    // them scroll past a Docker tutorial to find it is what lost them.
    expect(buildEntryChooser().options[0]?.id).toBe('joining');
  });

  it('prices each path so the expensive one is visibly expensive', () => {
    for (const option of buildEntryChooser().options) {
      expect(option.cost).toMatch(/minute|Fifteen|terminal/i);
    }
  });

  it('discriminates on what the user is holding, not what they intend', () => {
    // "Do you want to self-host?" is unanswerable before you understand the
    // product; "did someone send you a long block of text?" is checkable.
    const model = buildEntryChooser();
    expect(model.options[0]?.title).toMatch(/sent me/i);
    expect(model.footnote).toMatch(/long block of text/i);
  });

  it('never leaves someone unsure without a way forward', () => {
    expect(buildEntryChooser().footnote.length).toBeGreaterThan(20);
  });
});

describe('host view', () => {
  it('keeps the stack command copyable rather than prose', () => {
    const withCommand = buildHostView().steps.filter(
      (step) => step.command !== undefined,
    );
    expect(withCommand).toHaveLength(1);
    expect(withCommand[0]?.command).toBe('docker compose up -d');
  });

  it('links the guide absolutely, so the click reaches a browser', () => {
    // Regression on 1.1.2/1.1.5: a repo-relative href resolved against
    // Obsidian's own origin and did nothing at all.
    expect(buildHostView().guideUrl).toBe(SELF_HOSTING_GUIDE_URL);
    expect(SELF_HOSTING_GUIDE_URL).toMatch(/^https:\/\//);
  });

  it('ends on the action, not on more reading', () => {
    expect(buildHostView().primaryAction).toMatch(/connect/i);
  });
});

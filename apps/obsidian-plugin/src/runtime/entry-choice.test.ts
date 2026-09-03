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

describe('on a phone', () => {
  // A phone cannot host: the server needs Docker and a machine that stays
  // awake. Offering "I'll run the server" there sends the user down a path
  // that ends in a terminal they do not have, so the chooser drops to the one
  // real option and stops being a question.
  it('offers joining only', () => {
    const model = buildEntryChooser({ canHost: false });
    expect(model.options.map((option) => option.id)).toEqual(['joining']);
  });

  it('still explains what to do when nobody has a server yet', () => {
    // Dropping the option must not drop the information: someone whose group
    // has no server still needs to learn that one has to exist, and where.
    const model = buildEntryChooser({ canHost: false });
    expect(model.footnote).toMatch(/computer|desktop|machine/i);
  });

  it('does not ask "which are you" when there is nothing to choose', () => {
    const model = buildEntryChooser({ canHost: false });
    expect(model.question).not.toMatch(/which are you/i);
  });

  it('keeps both options on desktop', () => {
    expect(buildEntryChooser({ canHost: true }).options).toHaveLength(2);
    // The no-argument call is the desktop default, so existing callers and
    // tests keep their meaning.
    expect(buildEntryChooser().options).toHaveLength(2);
  });
});

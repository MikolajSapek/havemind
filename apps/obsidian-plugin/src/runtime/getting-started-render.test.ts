import { describe, expect, it } from 'vitest';

import {
  SELF_HOSTING_DOC_PATH,
  buildGettingStartedViewModel,
} from './getting-started-render';

describe('buildGettingStartedViewModel', () => {
  it('titles the tutorial "Getting started"', () => {
    expect(buildGettingStartedViewModel().title).toBe('Getting started');
  });

  it('lists exactly five numbered steps, in order, starting at one', () => {
    const model = buildGettingStartedViewModel();
    expect(model.steps).toHaveLength(5);
    expect(model.steps.map((step) => step.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps each step to a single imperative line', () => {
    for (const step of buildGettingStartedViewModel().steps) {
      expect(step.text).not.toContain('\n');
      expect(step.text.trim()).toBe(step.text);
      expect(step.text.length).toBeGreaterThan(0);
    }
  });

  it('walks the user through Tailscale, credentials, connect, the code and the payoff', () => {
    const texts = buildGettingStartedViewModel().steps.map((step) => step.text);
    expect(texts[0]).toContain('Tailscale');
    expect(texts[1]).toContain('Server URL');
    expect(texts[1]).toContain('pairing token');
    expect(texts[2]).toContain('Connect');
    expect(texts[3]).toContain('6-digit code');
    expect(texts[4]).toContain('dedicated vault');
  });

  it('links the second step to the self-hosting guide', () => {
    const credentials = buildGettingStartedViewModel().steps.find(
      (step) => step.number === 2,
    );
    expect(credentials?.docRef).toEqual({
      label: 'Self-hosting guide',
      url: SELF_HOSTING_DOC_PATH,
    });
    expect(SELF_HOSTING_DOC_PATH).toBe('docs/self-hosting.md');
  });

  it('attaches the doc link only to the credentials step', () => {
    const withDoc = buildGettingStartedViewModel().steps.filter(
      (step) => step.docRef !== undefined,
    );
    expect(withDoc.map((step) => step.number)).toEqual([2]);
  });

  it('footnotes where installing the plugin and running a server are documented', () => {
    const footnote = buildGettingStartedViewModel().footnote;
    expect(footnote).toContain('README');
    expect(footnote).toContain('docs/self-hosting.md');
  });

  it('never emits emoji in any user-facing string', () => {
    const model = buildGettingStartedViewModel();
    const strings = [
      model.title,
      model.footnote,
      ...model.steps.flatMap((step) => [
        step.text,
        step.docRef?.label ?? '',
      ]),
    ];
    const emoji = /\p{Extended_Pictographic}/u;
    for (const value of strings) {
      expect(emoji.test(value)).toBe(false);
    }
  });
});

/**
 * Every block on the first-run screens keeps the pane's side inset.
 *
 * `.havemind-view` gives up its own padding so chrome (the header, the tab
 * strip, the alarm block) can span the pane edge to edge; anything that is not
 * chrome sets the 12px inset back on itself. That list was written when the
 * pane's only screens were the connected ones, so it names `.havemind-hint`,
 * `h4`, `button` and the status rows, and nothing the entry chooser renders.
 *
 * The entry chooser and the host path mount their blocks as direct children of
 * `.havemind-view`. The result on a freshly installed plugin: the heading, its
 * mark, the subheading and the option rows run to the bare pane edge while the
 * two hints between them sit 12px in, so the first screen a new user sees has
 * its text on two different left edges and the option rows touching the frame.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('../../styles.css', import.meta.url)),
  'utf8',
);

/** The selectors in the rule that restores the pane's side inset. */
function insetSelectors(): readonly string[] {
  const rule = css.match(
    /([^{}]*)\{\s*margin-left:\s*12px;\s*margin-right:\s*12px;\s*\}/,
  );
  const selectorList = rule?.[1];
  if (selectorList === undefined) return [];
  return selectorList
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(',')
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0);
}

/**
 * Blocks the entry chooser and host path mount straight onto `.havemind-view`
 * (see `entry-chooser-section.ts`). `.havemind-entry-back` and
 * `.havemind-entry-primary` are buttons, so `.havemind-view > button` already
 * covers them; these are the ones nothing covers.
 */
const FIRST_RUN_BLOCKS = [
  '.havemind-entry-head',
  '.havemind-entry-subheading',
  '.havemind-entry-options',
  '.havemind-host-steps',
  // An `<a>`, so neither `.havemind-view > button` nor anything else on the
  // list covers it. Measured in a browser at 300px it sat flush against the
  // pane edge while every block above it was 12px in.
  '.havemind-step-link',
] as const;

/**
 * The first-run screens scroll, and end with air below.
 *
 * `.havemind-tab-body` gives every connected screen both: it takes the leftover
 * height, scrolls, and its `--havemind-body-pad` ends in 16px. The chooser and
 * the host path render no tab body, so measured in a browser the last line sat
 * flush on the pane's bottom edge (0px), and in a pane shorter than its content
 * the overflow could not be scrolled to at all, putting the host path's primary
 * button out of reach.
 *
 * jsdom computes no layout, so this reads the sheet rather than a rendered box:
 * the browser measurement lives in the preview harness. What it pins is that
 * the rule exists, covers BOTH screens, and sets both properties.
 */
describe('first-run screens scroll and end with air below', () => {
  // Scoped by a class the renderer sets, not by `:has()`: that version worked,
  // but `:has()` invalidates broadly enough that Obsidian's plugin review flags
  // it, and these screens already know who they are.
  const rule = css.match(
    /\.havemind-view\.havemind-view-scrolls\s*\{([^}]*)\}/,
  );

  it('declares a rule for the screens with no tab body', () => {
    expect(rule).not.toBeNull();
  });

  it('lets the pane scroll when the content outgrows it', () => {
    expect(rule?.[1] ?? '').toMatch(/overflow-y:\s*auto/);
  });

  it('keeps the last line off the bottom edge', () => {
    expect(rule?.[1] ?? '').toMatch(/padding-bottom:\s*var\(--havemind-first-run-pad\)/);
  });

  it('sizes that padding from the shared spacing scale', () => {
    expect(css).toMatch(/--havemind-first-run-pad:\s*var\(--size-4-4\)/);
  });

  it('uses no :has() in any selector', () => {
    // Comments may still name it, that is how the rule above explains itself;
    // what must not come back is a live selector.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/:has\(/);
  });
});

describe('first-run screens keep the pane inset', () => {
  const selectors = insetSelectors();

  it('finds the rule that restores the inset', () => {
    expect(selectors.length).toBeGreaterThan(0);
  });

  it.each(FIRST_RUN_BLOCKS)('%s sits inside the pane edge', (block) => {
    const covered = selectors.some(
      (selector) => selector === `.havemind-view > ${block}`,
    );
    expect(covered).toBe(true);
  });
});

describe('the entry cards grow with their text', () => {
  // Each card is a <button> holding two lines, a title and the cost below it.
  // Obsidian's theme gives every button a fixed height and `white-space:
  // nowrap`, so without these four the second line was clipped behind the next
  // card and the text ran past the pane's right edge. Screenshotted on the
  // disconnected screen, 1.4.7.
  const rule =
    /\.havemind-entry-option,\s*\.havemind-view button\.havemind-entry-option\s*\{([^}]*)\}/.exec(
      css,
    )?.[1] ?? '';

  it('finds the rule', () => {
    expect(rule).not.toBe('');
  });

  it('carries the element-qualified selector too', () => {
    // The values alone are not enough. A bare `.havemind-entry-option` loses
    // to Obsidian's own `button { display: inline-flex; align-items: center }`,
    // which laid the title and the cost side by side and pushed the cost out
    // below the card, overlapping the next one. Every other button in this
    // sheet is doubled the same way (`.havemind-action-row`,
    // `.havemind-pane-more`, `.havemind-invite-cta`); this one was not, which
    // is why the first fix did not take.
    expect(css).toContain(
      '.havemind-view button.havemind-entry-option',
    );
  });

  it.each([
    ['height', /height:\s*auto/],
    ['min-height', /min-height:\s*0/],
    ['white-space', /white-space:\s*normal/],
    ['overflow-wrap', /overflow-wrap:\s*anywhere/],
  ])('overrides the theme %s', (_name, pattern) => {
    expect(rule).toMatch(pattern);
  });
});

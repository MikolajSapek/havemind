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
  const rule = css.match(
    /(\.havemind-view:has\(> \.havemind-entry-options\)[^{]*)\{([^}]*)\}/,
  );

  it('declares a rule for the screens with no tab body', () => {
    expect(rule).not.toBeNull();
  });

  it('covers the host path as well as the chooser', () => {
    expect(rule?.[1] ?? '').toContain('.havemind-view:has(> .havemind-host-steps)');
  });

  it('lets the pane scroll when the content outgrows it', () => {
    expect(rule?.[2] ?? '').toMatch(/overflow-y:\s*auto/);
  });

  it('keeps the last line off the bottom edge', () => {
    expect(rule?.[2] ?? '').toMatch(/padding-bottom:\s*var\(--havemind-first-run-pad\)/);
  });

  it('sizes that padding from the shared spacing scale', () => {
    expect(css).toMatch(/--havemind-first-run-pad:\s*var\(--size-4-4\)/);
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

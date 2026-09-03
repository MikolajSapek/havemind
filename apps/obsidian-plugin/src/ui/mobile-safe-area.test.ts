/**
 * Phone layout rules from the mobile design handoff (2026-09-03).
 *
 * Two things the pane got wrong on a phone and that no desktop test could
 * catch, because the desktop sidebar has neither a notch nor a fingertip:
 *
 *  - the stylesheet had no `env(safe-area-inset-*)` handling at all, so on a
 *    device with a notch or a home indicator the pane's first and last rows sat
 *    underneath them;
 *  - the tab strip is 32px tall, below the 44px minimum touch target. The
 *    design keeps 32px on desktop (a mouse does not need 44) and raises the
 *    strip only on coarse pointers, which is what `pointer: coarse` selects.
 *
 * These assert the rules exist and are scoped so desktop geometry is untouched;
 * they do not attempt to prove rendered pixels, which needs a real device
 * (MOB-02).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  fileURLToPath(new URL('../../styles.css', import.meta.url)),
  'utf8',
);

/** The body of the first at-rule whose prelude matches, braces balanced. */
function atRuleBody(pattern: RegExp): string | undefined {
  const match = pattern.exec(stylesheet);
  if (match === null) return undefined;
  let depth = 0;
  for (let i = match.index; i < stylesheet.length; i += 1) {
    const char = stylesheet[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return stylesheet.slice(match.index, i + 1);
    }
  }
  return undefined;
}

describe('mobile safe-area insets', () => {
  it('pads the pane past the top inset', () => {
    expect(stylesheet).toMatch(/env\(safe-area-inset-top\)/);
  });

  it('keeps the last row clear of the home indicator with a floor', () => {
    // `max(...)` matters: on a device with no bottom inset the value resolves
    // to 0 and the final row would sit flush against the pane edge.
    // The floor may itself be a `var()`, so the first argument is matched
    // loosely; what matters is that the inset is wrapped, not bare.
    expect(stylesheet).toMatch(
      /max\([^;]*,\s*env\(safe-area-inset-bottom\)\s*\)/,
    );
  });

  it('pads both side insets, not just one', () => {
    expect(stylesheet).toMatch(/env\(safe-area-inset-left\)/);
    expect(stylesheet).toMatch(/env\(safe-area-inset-right\)/);
  });
});

describe('coarse-pointer touch targets', () => {
  const coarse = atRuleBody(/@media\s*\(pointer:\s*coarse\)/);

  it('raises the tab strip to the 44px minimum', () => {
    expect(coarse).toBeDefined();
    // The block overrides the rendered height via the touch token rather than
    // redeclaring `--havemind-tab-height`, which must stay unique.
    expect(coarse).toMatch(/height:\s*var\(--havemind-tab-height-touch\)/);

    // The design's phone cell is 52px; anything under 44 fails the platform
    // guidance the handoff cites.
    const touch = /--havemind-tab-height-touch:\s*(\d+)px/.exec(stylesheet);
    expect(touch).not.toBeNull();
    expect(Number(touch?.[1])).toBeGreaterThanOrEqual(44);
  });

  it('leaves the desktop strip at its designed height', () => {
    // The 32px declaration must survive outside the coarse block, or the
    // desktop sidebar inherits a phone-sized strip.
    const beforeCoarse = stylesheet.slice(
      0,
      stylesheet.indexOf('@media (pointer: coarse)'),
    );
    expect(beforeCoarse).toMatch(/--havemind-tab-height:\s*32px/);
  });
});

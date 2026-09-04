/**
 * AT3-4 / the Stage 3 ceiling: `onboarding-view.ts` under 250 lines, and no
 * file in `ui/screens/` over 200.
 *
 * The number is not aesthetic. A 1200-line view is where the 1.1.3 defect hid:
 * with every screen in one `render()`, a branch that returned early was
 * indistinguishable from one that fell through, and nothing pointed at the
 * difference. The ceiling is what keeps each screen small enough to read whole.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function lineCount(path: string): number {
  return readFileSync(path, 'utf8').split('\n').length;
}

describe('Stage 3 file ceilings', () => {
  it('keeps onboarding-view.ts under 250 lines', () => {
    const path = fileURLToPath(new URL('./onboarding-view.ts', import.meta.url));
    expect(lineCount(path)).toBeLessThanOrEqual(250);
  });

  it('keeps every screen under 200 lines', () => {
    const dir = fileURLToPath(new URL('./screens', import.meta.url));
    const files = readdirSync(dir).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    // A guard on the guard: an empty directory would pass vacuously.
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(lineCount(`${dir}/${name}`), `${name} is too long`).toBeLessThanOrEqual(200);
    }
  });
});

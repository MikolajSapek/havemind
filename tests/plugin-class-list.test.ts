/**
 * The generated class list holds classes, not custom properties.
 *
 * `list-plugin-classes.mjs` greps identifier-shaped strings rather than
 * tracking `addClass` calls, which is deliberate: a class assembled at runtime
 * still lands in the list. The cost is that `havemind-gap` reads the same
 * whether it was written as a class or as `--havemind-gap`, and the two dashes
 * sit outside the match.
 *
 * That mattered the moment a test asserted on a token name. `entry-inset.test.ts`
 * mentions `--havemind-first-run-pad`, the extractor read it as a class, and CI
 * failed on a list that had quietly stopped meaning "classes the source can
 * apply". Eleven custom properties were already in it by the same route.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

function generatedList(): readonly string[] {
  // Read what is committed rather than regenerating: CI fails when the two
  // disagree, so this asserts on the artefact the repository actually ships.
  return readFileSync(
    `${root}apps/obsidian-plugin/src/ui/known-classes.generated.txt`,
    'utf8',
  )
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

const stylesheet = readFileSync(
  `${root}apps/obsidian-plugin/styles.css`,
  'utf8',
);

/** The generator's own walk and filter, kept in step with the script. */
function extractClassNames(): readonly string[] {
  const src = `${root}apps/obsidian-plugin/src`;
  const walk = (dir: string): readonly string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  const names = new Set<string>();
  for (const file of walk(src).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/havemind-[a-z0-9-]+/g)) {
      if (/^havemind-[0-9a-f]{8}-/.test(match[0])) continue;
      if (source.startsWith('--', Math.max(0, (match.index ?? 0) - 2))) continue;
      names.add(match[0]);
    }
  }
  return [...names].sort();
}

describe('the generated plugin class list', () => {
  it('is not empty', () => {
    expect(generatedList().length).toBeGreaterThan(50);
  });

  it('holds no name that the stylesheet only ever uses as a custom property', () => {
    const properties = generatedList().filter(
      (name) =>
        stylesheet.includes(`--${name}`) && !stylesheet.includes(`.${name}`),
    );
    expect(properties).toEqual([]);
  });

  it('stays in step with the generator', () => {
    // Mirrors `scripts/list-plugin-classes.mjs` in-process rather than spawning
    // it: a synchronous child process blocks this worker's thread, and the e2e
    // suites sharing the run time out waiting for it. Same inputs, same rules,
    // so a stale commit still fails here before it reaches CI.
    expect(extractClassNames()).toEqual(generatedList());
  });
});

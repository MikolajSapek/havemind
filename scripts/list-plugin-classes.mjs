#!/usr/bin/env node
/**
 * List every `havemind-*` class the plugin source can apply.
 *
 * Feeds `stylesheet-conflicts.test.ts`, which fails when styles.css carries a
 * rule for a class nothing renders. Dead rules are not merely untidy: they are
 * read as evidence while debugging why the pane looks wrong, and two of them
 * (`.havemind-comb` for a glyph never written, `.havemind-nav-bar` for a footer
 * deleted a round earlier) cost real time on exactly that.
 *
 * Deliberately over-inclusive: it greps identifier-shaped strings rather than
 * tracking `addClass` calls, so a class built at runtime still lands in the
 * list. A name here that styles.css never mentions is fine, the test only
 * looks the other way.
 *
 * Usage: node scripts/list-plugin-classes.mjs
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../apps/obsidian-plugin/src', import.meta.url));
const OUT = fileURLToPath(
  new URL('../apps/obsidian-plugin/src/ui/known-classes.generated.txt', import.meta.url),
);

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const names = new Set();
for (const file of walk(SRC).filter((f) => f.endsWith('.ts'))) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/havemind-[a-z0-9-]+/g)) {
    // Client ids and refresh-token keys share the prefix but are not classes;
    // a UUID segment is the giveaway.
    if (/^havemind-[0-9a-f]{8}-/.test(match[0])) continue;
    // A custom property (`--havemind-gap`) is a value, never a class. The two
    // dashes sit outside the match, so without this check a test that asserts
    // on a token name adds that token to the class list, and the list stops
    // meaning "classes the source can apply".
    if (source.startsWith('--', Math.max(0, match.index - 2))) continue;
    names.add(match[0]);
  }
}

writeFileSync(
  OUT,
  [
    '# Generated: every havemind-* class the plugin source can apply.',
    '# Refresh: node scripts/list-plugin-classes.mjs',
    '# A class here but not in styles.css is fine (unstyled); the reverse is a dead rule.',
    ...[...names].sort(),
    '',
  ].join('\n'),
);

console.log(`Wrote ${OUT} (${names.size} classes)`);

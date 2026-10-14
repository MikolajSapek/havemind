import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The distribution repo's release workflow refuses a main.js with any of
// these (1.10.2's release failed there on a placeholder "….ts.net"). The
// bundle is built from these sources, so the check runs here first.
const DIST_MARKERS =
  /\.ts\.net|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|refresh_token|BEGIN [A-Z]* PRIVATE KEY|invitation_secret/u;

const src = fileURLToPath(new URL('../apps/obsidian-plugin/src/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('plugin sources carry nothing the distribution release refuses', () => {
  it('has no tailnet names, tailnet or LAN addresses, or secret markers', () => {
    const hits = sources(src).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) => (DIST_MARKERS.test(line) ? [`${file.slice(src.length)}:${index + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});

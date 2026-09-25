// The distribution repo ships the monorepo README. Links to files that only
// exist in the monorepo must become absolute, or they 404 on the plugin page.
import { describe, expect, it } from 'vitest';

import { distributionReadme } from '../scripts/dist-readme.mjs';

const MONOREPO = 'https://github.com/MikolajSapek/havemind/blob/main/';
const shipped = new Set(['CONTRIBUTING.md', 'design/brand/banner.png']);
const exists = (path: string): boolean => shipped.has(path);

describe('distributionReadme', () => {
  it('points links to monorepo-only files at the monorepo', () => {
    expect(distributionReadme('See [guide](docs/self-hosting.md).', exists)).toBe(
      `See [guide](${MONOREPO}docs/self-hosting.md).`,
    );
  });

  it('keeps the anchor on a rewritten link', () => {
    expect(distributionReadme('[s](docs/self-hosting.md#the-key)', exists)).toBe(
      `[s](${MONOREPO}docs/self-hosting.md#the-key)`,
    );
  });

  it('leaves links to shipped files, anchors and absolute URLs alone', () => {
    const text = [
      '[c](CONTRIBUTING.md)',
      '[m](#security-model)',
      '[o](https://obsidian.md)',
      '<img src="design/brand/banner.png">',
    ].join('\n');
    expect(distributionReadme(text, exists)).toBe(text);
  });
});

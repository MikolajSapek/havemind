/**
 * The README version must match the shipped manifest.
 *
 * This test exists because the README sat at "Version 1.2.3" while 1.4.7 was in
 * the catalogue: seven releases went out and the first line a visitor reads was
 * wrong every time. A release checklist item did not prevent that, so the rule
 * is enforced here instead of being remembered.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

function manifestVersion(): string {
  const raw = readFileSync(join(ROOT, 'apps/obsidian-plugin/manifest.json'), 'utf8');
  const version: unknown = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error('manifest.json has no string version');
  return version;
}

function readme(): string {
  return readFileSync(join(ROOT, 'README.md'), 'utf8');
}

describe('README stays current with the release', () => {
  it('states the version that manifest.json ships', () => {
    const version = manifestVersion();
    const stated = /\*\*Version (\d+\.\d+\.\d+)/.exec(readme());
    expect(stated?.[1], 'README has no "**Version X.Y.Z" line').toBeDefined();
    expect(
      stated?.[1],
      `README says ${stated?.[1] ?? 'nothing'} but manifest.json ships ${version}. ` +
        'Update the README version line as part of the release.',
    ).toBe(version);
  });

  it('tells the reader the plugin runs on mobile', () => {
    // isDesktopOnly:false only makes the plugin installable on a phone. Nothing
    // in the catalogue tells a human, so the README has to.
    expect(readme()).toMatch(/\bmobile\b/i);
  });

  it('leads with the hero animation that proves it', () => {
    // A still frame cannot show a one-second sync, so the hero is a GIF of a
    // note typed on the laptop arriving on the phone. Losing it would leave
    // every claim below unillustrated.
    expect(readme()).toContain('design/brand/havemind-hero.gif');
  });
});

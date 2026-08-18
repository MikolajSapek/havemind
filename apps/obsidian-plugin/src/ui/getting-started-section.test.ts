/**
 * Rendering coverage for the getting-started tutorial's documentation link.
 *
 * The link shipped inert twice: first as a repo-relative href that Obsidian
 * resolved against its own origin, then as an absolute href that still did
 * nothing, because a bare <a> inside a plugin view does not reliably reach the
 * OS browser. `getting-started-render.test.ts` only pins the URL *value*, which
 * both broken versions satisfied — so these tests pin the click *behaviour*.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildGettingStartedViewModel } from '../runtime/getting-started-render';
import { renderGettingStarted } from './getting-started-section';
import { createMockElement, type MockElement } from '../test/obsidian.mock';

const GUIDE_URL =
  'https://github.com/MikolajSapek/havemind/blob/main/docs/self-hosting.md';

function flatten(el: MockElement): MockElement[] {
  return [el, ...(el.children ?? []).flatMap(flatten)];
}

function renderAndFindLink(): MockElement {
  const root = createMockElement();
  renderGettingStarted(
    root as unknown as HTMLElement,
    buildGettingStartedViewModel(),
  );
  const link = flatten(root).find((el) => el.tag === 'a');
  if (link === undefined) throw new Error('no link was rendered');
  return link;
}

describe('renderGettingStarted', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the guide in the browser when the link is clicked', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });

    renderAndFindLink().triggerEvent('click', { preventDefault: () => {} });

    expect(open).toHaveBeenCalledWith(GUIDE_URL, '_blank');
  });

  it('marks the link as external so Obsidian treats it as one', () => {
    const link = renderAndFindLink();
    expect(link.classes).toContain('external-link');
    expect(link.attrs.href).toBe(GUIDE_URL);
  });
});

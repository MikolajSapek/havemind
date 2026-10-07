import { describe, expect, it } from 'vitest';

import { buildFlowerModel } from '../runtime/flower-model';
import type { RosterMember } from '../runtime/roster';
import { asEl, createContent, flatten } from '../test/dom';
import type { MockElement } from '../test/obsidian.mock';

import { renderFlower } from './flower';

const members: RosterMember[] = [
  { membershipId: 'm1', displayName: 'Mikołaj Sapek', role: 'owner', self: true },
  { membershipId: 'm2', displayName: 'MIKI IPHONE', role: 'editor', self: false },
  { membershipId: 'm3', displayName: 'Hubert', role: 'editor', self: false },
];

function draw(status: 'synced' | 'syncing' | 'offline', extra: { conflictAuthors?: string[] } = {}): MockElement {
  const content = createContent();
  renderFlower(asEl(content), buildFlowerModel({ members, status, ...extra }));
  const svg = content.children[0];
  if (svg === undefined) throw new Error('no svg');
  return svg;
}

const withClass = (root: MockElement, cls: string): MockElement[] =>
  flatten(root).filter((el) => el.classes.includes(cls));

describe('renderFlower', () => {
  it('is one image with an accessible name', () => {
    const svg = draw('synced');
    expect(svg.tag).toBe('svg');
    expect(svg.attrs.role).toBe('img');
    expect(svg.attrs['aria-label']).toContain('3 devices');
    expect(svg.attrs.viewBox).toMatch(/^0 0 \d+ \d+$/);
  });

  it('draws the core, six seats, and a spoke for every member seat', () => {
    const svg = draw('synced');
    expect(withClass(svg, 'havemind-flower-core')).toHaveLength(1);
    expect(withClass(svg, 'havemind-flower-seat')).toHaveLength(6);
    expect(withClass(svg, 'havemind-flower-spoke')).toHaveLength(3);
    expect(withClass(svg, 'is-free')).toHaveLength(3);
  });

  it('writes initials into the member seats only', () => {
    const labels = withClass(draw('synced'), 'havemind-flower-label').map((el) => el.text);
    expect(labels).toEqual(['you', 'MI', 'H']);
  });

  it('marks the core state with a class the stylesheet animates', () => {
    expect(draw('synced').classes).toContain('is-alive');
    expect(draw('syncing').classes).toContain('is-syncing');
    expect(draw('offline').classes).toContain('is-unreachable');
    const seats = withClass(draw('offline'), 'havemind-flower-seat');
    expect(seats.filter((el) => el.classes.includes('is-self-offline'))).toHaveLength(1);
  });

  it('splits a conflicted seat with a second shape, not a gradient', () => {
    const svg = draw('synced', { conflictAuthors: ['MIKI IPHONE'] });
    expect(withClass(svg, 'havemind-flower-split')).toHaveLength(1);
    expect(flatten(svg).some((el) => el.tag === 'linearGradient')).toBe(false);
  });
});

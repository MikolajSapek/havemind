import { describe, expect, it } from 'vitest';

import { createMockElement } from '../../test/obsidian.mock';

import { captureDrafts } from './connect-form';

function select(value: string): HTMLElement {
  const el = createMockElement();
  el.value = value;
  return el as unknown as HTMLElement;
}

describe('captureDrafts keeps the invitation role across a repaint', () => {
  it.each(['owner', 'agent', 'editor'])('keeps %s', (role) => {
    const draft = { token: '', server: '', role: 'editor', name: '' };
    captureDrafts(draft, { role: select(role) });
    expect(draft.role).toBe(role);
  });

  it('falls back to editor for anything else', () => {
    const draft = { token: '', server: '', role: 'agent', name: '' };
    captureDrafts(draft, { role: select('admin') });
    expect(draft.role).toBe('editor');
  });
});

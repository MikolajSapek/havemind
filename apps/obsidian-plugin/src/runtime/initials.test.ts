import { describe, expect, it } from 'vitest';

import { assignInitials, initialsFor } from './initials';

describe('initialsFor', () => {
  it('takes the first letter of the first two words', () => {
    expect(initialsFor('Mikołaj Sapek')).toBe('MS');
    expect(initialsFor('MIKI IPHONE')).toBe('MI');
    expect(initialsFor('anna maria nowak')).toBe('AM');
  });

  it('takes one letter from a single word', () => {
    expect(initialsFor('Hubert')).toBe('H');
    expect(initialsFor('łucja')).toBe('Ł');
  });

  it('skips characters that are not letters', () => {
    expect(initialsFor('  (Magda)  Kowalska ')).toBe('MK');
    expect(initialsFor('iPhone 15')).toBe('I');
  });

  it('falls back to a question mark when there is nothing to use', () => {
    expect(initialsFor('')).toBe('?');
    expect(initialsFor('  42 ')).toBe('?');
  });
});

describe('assignInitials', () => {
  it('keeps plain initials when they are unique', () => {
    const result = assignInitials([
      { id: 'a', name: 'Mikołaj Sapek' },
      { id: 'b', name: 'MIKI IPHONE' },
      { id: 'c', name: 'Hubert' },
    ]);
    expect(result.get('a')).toBe('MS');
    expect(result.get('b')).toBe('MI');
    expect(result.get('c')).toBe('H');
  });

  it('uses two letters of the first word when initials collide', () => {
    const result = assignInitials([
      { id: 'a', name: 'Mikołaj Sapek' },
      { id: 'b', name: 'Magda Smith' },
      { id: 'c', name: 'Hubert' },
      { id: 'd', name: 'Hanna' },
    ]);
    expect(result.get('a')).toBe('Mi');
    expect(result.get('b')).toBe('Ma');
    expect(result.get('c')).toBe('Hu');
    expect(result.get('d')).toBe('Ha');
  });

  it('numbers members that still collide, in input order', () => {
    const result = assignInitials([
      { id: 'a', name: 'Mac' },
      { id: 'b', name: 'Mac' },
    ]);
    expect(result.get('a')).toBe('M1');
    expect(result.get('b')).toBe('M2');
  });
});

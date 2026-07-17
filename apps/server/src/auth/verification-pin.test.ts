import { describe, expect, it } from 'vitest';

import {
  generateVerificationPin,
  parseVerificationPin,
  VerificationPinError,
} from './verification-pin.js';

describe('generateVerificationPin', () => {
  it('always produces exactly six ASCII digits', () => {
    for (let index = 0; index < 2000; index += 1) {
      const pin = generateVerificationPin();
      expect(pin).toMatch(/^[0-9]{6}$/u);
      expect(pin).toHaveLength(6);
    }
  });

  it('round-trips through parseVerificationPin unchanged', () => {
    for (let index = 0; index < 500; index += 1) {
      const pin = generateVerificationPin();
      expect(parseVerificationPin(pin)).toBe(pin);
    }
  });
});

describe('parseVerificationPin', () => {
  it('accepts a canonical six-digit PIN, including leading zeros', () => {
    expect(parseVerificationPin('000000')).toBe('000000');
    expect(parseVerificationPin('123456')).toBe('123456');
    expect(parseVerificationPin('999999')).toBe('999999');
  });

  it('rejects anything that is not exactly six digits', () => {
    for (const value of [
      '',
      '12345',
      '1234567',
      '12 345',
      '12345a',
      ' 123456',
      '123456 ',
      'abcdef',
      '−12345',
    ]) {
      expect(() => parseVerificationPin(value)).toThrow(VerificationPinError);
    }
  });

  it('rejects a non-string value without leaking it', () => {
    // @ts-expect-error deliberately passing a wrong type to prove the guard.
    expect(() => parseVerificationPin(123456)).toThrow(VerificationPinError);
  });
});

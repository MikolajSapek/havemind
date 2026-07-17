import { randomInt } from 'node:crypto';

/**
 * The device-approval verification value is a 6-digit numeric PIN, read aloud by
 * the joining device to the vault owner over an out-of-band human channel. It is
 * generated once per invitation with the platform CSPRNG (never `Math.random`)
 * and stored verbatim, so the value the invitee sees and the value the server
 * compares are byte-identical — there is no derivation step that could diverge.
 *
 * Six digits is low entropy on its own; the server-authoritative 3-attempt cap
 * (`MAX_APPROVAL_ATTEMPTS`) bounds guessing, so no extra complexity is added.
 */

const PIN_DIGITS = 6;
/** Exclusive upper bound: 0..999999 covers every zero-padded 6-digit value. */
const PIN_UPPER_BOUND = 1_000_000;
const PIN_PATTERN = /^[0-9]{6}$/u;

declare const verificationPinBrand: unique symbol;

export type VerificationPin = string & {
  readonly [verificationPinBrand]: 'VerificationPin';
};

export type VerificationPinErrorCode = 'INVALID_VERIFICATION_PIN';

const ERROR_MESSAGES: Readonly<Record<VerificationPinErrorCode, string>> = {
  INVALID_VERIFICATION_PIN: 'Invalid verification PIN.',
};

/** A deliberately input-free error safe to log or serialize (never the PIN). */
export class VerificationPinError extends Error {
  public readonly code: VerificationPinErrorCode;

  public constructor(code: VerificationPinErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'VerificationPinError';
    this.code = code;
  }
}

/** Generates a uniformly random, zero-padded 6-digit PIN using the CSPRNG. */
export function generateVerificationPin(): VerificationPin {
  const value = randomInt(0, PIN_UPPER_BOUND);
  return String(value).padStart(PIN_DIGITS, '0') as VerificationPin;
}

/** Validates that `value` is exactly six ASCII digits. */
export function parseVerificationPin(value: string): VerificationPin {
  if (typeof value !== 'string' || !PIN_PATTERN.test(value)) {
    throw new VerificationPinError('INVALID_VERIFICATION_PIN');
  }
  return value as VerificationPin;
}

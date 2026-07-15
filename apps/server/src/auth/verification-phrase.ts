import { createHmac, randomBytes } from 'node:crypto';

const SECRET_PREFIX = 'hm_vps_';
const SECRET_BYTE_LENGTH = 32;
const SECRET_PAYLOAD_LENGTH = 43;
const PHRASE_BYTE_LENGTH = 6;
const PHRASE_DOMAIN = 'havemind/verification-phrase/v1';
const SECRET_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const VERIFICATION_PHRASE_COLORS = Object.freeze([
  'amber',
  'aqua',
  'blue',
  'bronze',
  'coral',
  'cyan',
  'gold',
  'green',
  'indigo',
  'ivory',
  'lime',
  'orange',
  'pink',
  'purple',
  'red',
  'silver',
] as const);

export const VERIFICATION_PHRASE_NOUNS = Object.freeze([
  'badger',
  'bear',
  'bird',
  'cat',
  'deer',
  'dog',
  'eagle',
  'fox',
  'frog',
  'horse',
  'lion',
  'otter',
  'panda',
  'rabbit',
  'tiger',
  'wolf',
] as const);

type Nibble =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15;

declare const verificationSecretBrand: unique symbol;
declare const verificationPhraseBrand: unique symbol;

export type VerificationSecret = string & {
  readonly [verificationSecretBrand]: 'VerificationSecret';
};
export type VerificationPhrase = string & {
  readonly [verificationPhraseBrand]: 'VerificationPhrase';
};

export interface VerificationPhraseContext {
  readonly vaultId: string;
  readonly invitationId: string;
  readonly pendingDeviceId: string;
  readonly inviterDeviceId: string;
}

export type VerificationPhraseErrorCode =
  | 'INVALID_VERIFICATION_SECRET'
  | 'INVALID_VERIFICATION_CONTEXT'
  | 'INVALID_VERIFICATION_PHRASE';

const ERROR_MESSAGES: Readonly<Record<VerificationPhraseErrorCode, string>> = {
  INVALID_VERIFICATION_SECRET: 'Invalid verification secret.',
  INVALID_VERIFICATION_CONTEXT: 'Invalid verification context.',
  INVALID_VERIFICATION_PHRASE: 'Invalid verification phrase.',
};

/** A deliberately input-free error safe to log or serialize. */
export class VerificationPhraseError extends Error {
  public readonly code: VerificationPhraseErrorCode;

  public constructor(code: VerificationPhraseErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'VerificationPhraseError';
    this.code = code;
  }

  public toJSON(): Readonly<{
    name: string;
    code: VerificationPhraseErrorCode;
    message: string;
  }> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    };
  }
}

const CONTEXT_FIELDS = [
  'vaultId',
  'invitationId',
  'pendingDeviceId',
  'inviterDeviceId',
] as const;

const PHRASE_TOKENS: ReadonlySet<string> = new Set(
  VERIFICATION_PHRASE_COLORS.flatMap((color) =>
    VERIFICATION_PHRASE_NOUNS.map((noun) => `${color}-${noun}`),
  ),
);

function encodeField(tag: number, value: string): Buffer {
  const valueBytes = Buffer.from(value, 'utf8');
  const encoded = Buffer.alloc(3 + valueBytes.length);
  encoded.writeUInt8(tag, 0);
  encoded.writeUInt16BE(valueBytes.length, 1);
  valueBytes.copy(encoded, 3);
  return encoded;
}

function validateContext(
  context: VerificationPhraseContext,
): readonly [string, string, string, string] {
  if (
    typeof context !== 'object' ||
    context === null ||
    Array.isArray(context) ||
    Object.keys(context).length !== CONTEXT_FIELDS.length
  ) {
    throw new VerificationPhraseError('INVALID_VERIFICATION_CONTEXT');
  }

  const values = CONTEXT_FIELDS.map((field) => context[field]);
  if (
    CONTEXT_FIELDS.some((field) => !Object.hasOwn(context, field)) ||
    values.some(
      (value) =>
        typeof value !== 'string' || !CANONICAL_UUID_PATTERN.test(value),
    )
  ) {
    throw new VerificationPhraseError('INVALID_VERIFICATION_CONTEXT');
  }

  return values as [string, string, string, string];
}

function encodeContext(context: VerificationPhraseContext): Buffer {
  const [vaultId, invitationId, pendingDeviceId, inviterDeviceId] =
    validateContext(context);

  return Buffer.concat([
    encodeField(0, PHRASE_DOMAIN),
    encodeField(1, vaultId),
    encodeField(2, invitationId),
    encodeField(3, pendingDeviceId),
    encodeField(4, inviterDeviceId),
  ]);
}

function renderPhrase(bytes: Buffer): VerificationPhrase {
  const tokens = Array.from(bytes, (byte) => {
    const color = VERIFICATION_PHRASE_COLORS[(byte >>> 4) as Nibble];
    const noun = VERIFICATION_PHRASE_NOUNS[(byte & 0x0f) as Nibble];
    return `${color}-${noun}`;
  });
  return tokens.join(' ') as VerificationPhrase;
}

export function generateVerificationSecret(): VerificationSecret {
  const payload = randomBytes(SECRET_BYTE_LENGTH).toString('base64url');
  return `${SECRET_PREFIX}${payload}` as VerificationSecret;
}

export function parseVerificationSecret(value: string): VerificationSecret {
  if (
    typeof value !== 'string' ||
    value.length !== SECRET_PREFIX.length + SECRET_PAYLOAD_LENGTH ||
    !value.startsWith(SECRET_PREFIX)
  ) {
    throw new VerificationPhraseError('INVALID_VERIFICATION_SECRET');
  }

  const payload = value.slice(SECRET_PREFIX.length);
  if (!SECRET_PAYLOAD_PATTERN.test(payload)) {
    throw new VerificationPhraseError('INVALID_VERIFICATION_SECRET');
  }

  const bytes = Buffer.from(payload, 'base64url');
  if (
    bytes.length !== SECRET_BYTE_LENGTH ||
    bytes.toString('base64url') !== payload
  ) {
    throw new VerificationPhraseError('INVALID_VERIFICATION_SECRET');
  }

  return value as VerificationSecret;
}

/**
 * Derives a 48-bit code for direct person-to-person comparison.
 * It does not protect either person from a malicious server controlling both
 * views of the comparison.
 */
export function deriveVerificationPhrase(
  secret: VerificationSecret,
  context: VerificationPhraseContext,
): VerificationPhrase {
  const validatedSecret = parseVerificationSecret(secret);
  const secretBytes = Buffer.from(
    validatedSecret.slice(SECRET_PREFIX.length),
    'base64url',
  );
  const digest = createHmac('sha256', secretBytes)
    .update(encodeContext(context))
    .digest();

  return renderPhrase(digest.subarray(0, PHRASE_BYTE_LENGTH));
}

export function parseVerificationPhrase(value: string): VerificationPhrase {
  if (typeof value !== 'string') {
    throw new VerificationPhraseError('INVALID_VERIFICATION_PHRASE');
  }

  const tokens = value.split(' ');
  if (
    tokens.length !== PHRASE_BYTE_LENGTH ||
    tokens.some((token) => !PHRASE_TOKENS.has(token))
  ) {
    throw new VerificationPhraseError('INVALID_VERIFICATION_PHRASE');
  }

  return value as VerificationPhrase;
}

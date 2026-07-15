import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  VERIFICATION_PHRASE_COLORS,
  VERIFICATION_PHRASE_NOUNS,
  VerificationPhraseError,
  deriveVerificationPhrase,
  generateVerificationSecret,
  parseVerificationPhrase,
  parseVerificationSecret,
  type VerificationPhrase,
  type VerificationPhraseContext,
  type VerificationSecret,
} from './verification-phrase.js';

const ZERO_SECRET = `hm_vps_${'A'.repeat(43)}`;
const CONTEXT: VerificationPhraseContext = {
  vaultId: '00000000-0000-4000-8000-000000000001',
  invitationId: '00000000-0000-4000-8000-000000000002',
  pendingDeviceId: '00000000-0000-4000-8000-000000000003',
  inviterDeviceId: '00000000-0000-4000-8000-000000000004',
};
const FIXED_PHRASE =
  'gold-dog ivory-panda red-frog aqua-deer cyan-dog silver-bird';

function captureError(action: () => unknown): Error {
  try {
    action();
    throw new Error('Expected verification phrase primitive to throw.');
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return error;
  }
}

describe('verification phrase', () => {
  it('generates unique canonical 256-bit per-device secrets', () => {
    const secrets = Array.from({ length: 256 }, () =>
      generateVerificationSecret(),
    );

    expect(new Set(secrets)).toHaveLength(256);
    for (const secret of secrets) {
      expect(secret).toMatch(/^hm_vps_[A-Za-z0-9_-]{43}$/u);
      expect(secret).not.toContain('=');
      expect(Buffer.from(secret.slice('hm_vps_'.length), 'base64url')).toHaveLength(
        32,
      );
    }
  });

  it('provides two fixed 16-word lists with 256 unique color-noun tokens', () => {
    expect(VERIFICATION_PHRASE_COLORS).toHaveLength(16);
    expect(VERIFICATION_PHRASE_NOUNS).toHaveLength(16);
    expect(new Set(VERIFICATION_PHRASE_COLORS)).toHaveLength(16);
    expect(new Set(VERIFICATION_PHRASE_NOUNS)).toHaveLength(16);

    const vocabulary = VERIFICATION_PHRASE_COLORS.flatMap((color) =>
      VERIFICATION_PHRASE_NOUNS.map((noun) => `${color}-${noun}`),
    );
    expect(new Set(vocabulary)).toHaveLength(256);
  });

  it('strictly parses only canonical 32-byte secrets without normalization', () => {
    expect(parseVerificationSecret(ZERO_SECRET)).toBe(ZERO_SECRET);

    const invalid = [
      ` ${ZERO_SECRET}`,
      `${ZERO_SECRET} `,
      `${ZERO_SECRET}=`,
      `HM_VPS_${'A'.repeat(43)}`,
      `hm_vps_${'A'.repeat(42)}`,
      `hm_vps_${'A'.repeat(44)}`,
      `hm_vps_${'A'.repeat(42)}+`,
      `hm_vps_${'A'.repeat(42)}/`,
      `hm_vps_${'A'.repeat(42)}B`,
      `hm_vps_${'ą'.repeat(43)}`,
    ];

    for (const secret of invalid) {
      expect(() => parseVerificationSecret(secret)).toThrow(
        VerificationPhraseError,
      );
    }
    expect(() =>
      parseVerificationSecret(null as unknown as string),
    ).toThrow(VerificationPhraseError);
  });

  it('matches a stable domain-separated HMAC-SHA-256 vector', () => {
    const secret = parseVerificationSecret(ZERO_SECRET);

    expect(deriveVerificationPhrase(secret, CONTEXT)).toBe(FIXED_PHRASE);
    expect(deriveVerificationPhrase(secret, CONTEXT)).toBe(FIXED_PHRASE);
  });

  it('scopes the phrase to every context field and its role', () => {
    const secret = parseVerificationSecret(ZERO_SECRET);
    const phrases = [
      deriveVerificationPhrase(secret, CONTEXT),
      deriveVerificationPhrase(secret, {
        ...CONTEXT,
        vaultId: '00000000-0000-4000-8000-000000000005',
      }),
      deriveVerificationPhrase(secret, {
        ...CONTEXT,
        invitationId: '00000000-0000-4000-8000-000000000006',
      }),
      deriveVerificationPhrase(secret, {
        ...CONTEXT,
        pendingDeviceId: '00000000-0000-4000-8000-000000000007',
      }),
      deriveVerificationPhrase(secret, {
        ...CONTEXT,
        inviterDeviceId: '00000000-0000-4000-8000-000000000008',
      }),
      deriveVerificationPhrase(secret, {
        ...CONTEXT,
        pendingDeviceId: CONTEXT.inviterDeviceId,
        inviterDeviceId: CONTEXT.pendingDeviceId,
      }),
    ];

    expect(new Set(phrases)).toHaveLength(phrases.length);
  });

  it('encodes exactly the first 48 HMAC bits as six canonical tokens', () => {
    const phrase = deriveVerificationPhrase(
      parseVerificationSecret(ZERO_SECRET),
      CONTEXT,
    );
    const vocabulary = new Set(
      VERIFICATION_PHRASE_COLORS.flatMap((color) =>
        VERIFICATION_PHRASE_NOUNS.map((noun) => `${color}-${noun}`),
      ),
    );
    const tokens = phrase.split(' ');

    expect(tokens).toHaveLength(6);
    for (const token of tokens) {
      expect(vocabulary.has(token)).toBe(true);
    }
  });

  it('parses phrases canonically without trimming, case folding or separator repair', () => {
    expect(parseVerificationPhrase(FIXED_PHRASE)).toBe(FIXED_PHRASE);

    const tokens = FIXED_PHRASE.split(' ');
    const invalid = [
      ` ${FIXED_PHRASE}`,
      `${FIXED_PHRASE} `,
      FIXED_PHRASE.toUpperCase(),
      FIXED_PHRASE.replace(' ', '  '),
      FIXED_PHRASE.replace(' ', '\n'),
      FIXED_PHRASE.replace('gold-dog', 'white-dog'),
      FIXED_PHRASE.replace('gold-dog', 'gold_dog'),
      tokens.slice(0, 5).join(' '),
      [...tokens, 'amber-wolf'].join(' '),
    ];

    for (const phrase of invalid) {
      expect(() => parseVerificationPhrase(phrase)).toThrow(
        VerificationPhraseError,
      );
    }
    expect(() =>
      parseVerificationPhrase(null as unknown as string),
    ).toThrow(VerificationPhraseError);
  });

  it('requires an exact four-field context object', () => {
    const secret = parseVerificationSecret(ZERO_SECRET);
    const malformed = [
      null,
      'context',
      [],
      { ...CONTEXT, extraId: CONTEXT.vaultId },
      {
        vaultId: CONTEXT.vaultId,
        invitationId: CONTEXT.invitationId,
        pendingDeviceId: CONTEXT.pendingDeviceId,
        otherId: CONTEXT.inviterDeviceId,
      },
      { ...CONTEXT, vaultId: 42 },
    ];

    for (const context of malformed) {
      expect(() =>
        deriveVerificationPhrase(
          secret,
          context as unknown as VerificationPhraseContext,
        ),
      ).toThrow(VerificationPhraseError);
    }
  });

  it('strictly rejects non-canonical UUID context identifiers', () => {
    const secret = parseVerificationSecret(ZERO_SECRET);
    const invalidIds = [
      '',
      'not-a-uuid',
      ` ${CONTEXT.vaultId}`,
      'ABCDEF00-0000-4000-8000-000000000001',
      '00000000-0000-9000-8000-000000000001',
      '00000000-0000-4000-7000-000000000001',
    ];

    for (const invalidId of invalidIds) {
      for (const field of Object.keys(CONTEXT) as Array<
        keyof VerificationPhraseContext
      >) {
        expect(() =>
          deriveVerificationPhrase(secret, {
            ...CONTEXT,
            [field]: invalidId,
          }),
        ).toThrow(VerificationPhraseError);
      }
    }
  });

  it('revalidates a forged secret brand before computing an HMAC', () => {
    expect(() =>
      deriveVerificationPhrase('hm_vps_not-canonical' as VerificationSecret, CONTEXT),
    ).toThrow(VerificationPhraseError);
  });

  it('uses distinct compile-time brands for the secret and rendered phrase', () => {
    expectTypeOf(generateVerificationSecret()).toEqualTypeOf<VerificationSecret>();
    expectTypeOf(parseVerificationPhrase(FIXED_PHRASE)).toEqualTypeOf<VerificationPhrase>();
    expectTypeOf<VerificationSecret>().not.toEqualTypeOf<VerificationPhrase>();
  });

  it('never includes rejected secrets or inputs in errors or JSON', () => {
    const rejectedSecret = 'hm_vps_SECRET_MUST_STAY_PRIVATE';
    const rejectedId = 'PRIVATE-CONTEXT-ID';
    const rejectedPhrase = 'PRIVATE HUMAN PHRASE';
    const errors = [
      captureError(() => parseVerificationSecret(rejectedSecret)),
      captureError(() =>
        deriveVerificationPhrase(parseVerificationSecret(ZERO_SECRET), {
          ...CONTEXT,
          pendingDeviceId: rejectedId,
        }),
      ),
      captureError(() => parseVerificationPhrase(rejectedPhrase)),
    ];

    const rendered = errors
      .flatMap((error) => [error.message, error.stack, JSON.stringify(error)])
      .join('\n');

    for (const rejected of [rejectedSecret, rejectedId, rejectedPhrase]) {
      expect(rendered).not.toContain(rejected);
    }
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.any(VerificationPhraseError),
        expect.any(VerificationPhraseError),
        expect.any(VerificationPhraseError),
      ]),
    );
  });
});

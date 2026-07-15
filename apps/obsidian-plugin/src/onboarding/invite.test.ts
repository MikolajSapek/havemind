import { describe, expect, it } from 'vitest';

import {
  PASSIVE_OBSIDIAN_JOIN_URL,
  InviteFormatError,
  buildInviteEnvelope,
  buildLandingInviteUrl,
  isSafePassiveJoinProtocolData,
  parseInviteEnvelope,
  parseLandingInviteUrl,
  parsePassiveObsidianJoinUrl,
} from './invite';

const INVITATION_TOKEN =
  'hm_it_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CANONICAL_ENVELOPE =
  'v1.eyJ2ZXJzaW9uIjoxLCJzZXJ2ZXJPcmlnaW4iOiJodHRwczovL3N5bmMuZXhhbXBsZS50ZXN0IiwiaW52aXRhdGlvblRva2VuIjoiaG1faXRfQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSJ9';

describe('onboarding canonical invitation envelope', () => {
  it('produces a stable versioned base64url vector without padding', () => {
    const envelope = buildInviteEnvelope({
      invitationToken: INVITATION_TOKEN,
      serverOrigin: 'https://sync.example.test',
    });

    expect(envelope).toBe(CANONICAL_ENVELOPE);
    expect(envelope).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(envelope).not.toContain('=');
    expect(parseInviteEnvelope(envelope)).toEqual({
      invitationToken: INVITATION_TOKEN,
      serverOrigin: 'https://sync.example.test',
      version: 1,
    });
  });

  it('places the complete secret envelope only in the HTTPS landing fragment', () => {
    const landingUrl = buildLandingInviteUrl(CANONICAL_ENVELOPE);
    const parsedUrl = new URL(landingUrl);

    expect(landingUrl).toBe(
      `https://sync.example.test/join#${CANONICAL_ENVELOPE}`,
    );
    expect(parsedUrl.search).toBe('');
    expect(parsedUrl.pathname).toBe('/join');
    expect(parsedUrl.href.slice(0, parsedUrl.href.indexOf('#'))).not.toContain(
      INVITATION_TOKEN,
    );
    expect(parseLandingInviteUrl(landingUrl)).toEqual({
      invitationToken: INVITATION_TOKEN,
      serverOrigin: 'https://sync.example.test',
      version: 1,
    });
  });

  it.each([
    ` ${CANONICAL_ENVELOPE}`,
    `#${CANONICAL_ENVELOPE}`,
    `${CANONICAL_ENVELOPE}=`,
    CANONICAL_ENVELOPE.replace('v1.', 'v2.'),
    CANONICAL_ENVELOPE.replace('eyJ', 'ey+'),
    CANONICAL_ENVELOPE.replace('eyJ', '%65yJ'),
    'v1._w',
  ])('rejects non-canonical base64url input without normalization', (input) => {
    expect(() => parseInviteEnvelope(input)).toThrow(InviteFormatError);
  });

  it('rejects semantically valid JSON when bytes or property order are not canonical', () => {
    const reordered = encodeRawJson(
      JSON.stringify({
        invitationToken: INVITATION_TOKEN,
        serverOrigin: 'https://sync.example.test',
        version: 1,
      }),
    );
    const spaced = encodeRawJson(
      JSON.stringify(
        {
          version: 1,
          serverOrigin: 'https://sync.example.test',
          invitationToken: INVITATION_TOKEN,
        },
        null,
        2,
      ),
    );

    expect(() => parseInviteEnvelope(reordered)).toThrow(InviteFormatError);
    expect(() => parseInviteEnvelope(spaced)).toThrow(InviteFormatError);
  });

  it.each([
    'http://sync.example.test',
    'https://sync.example.test/',
    'https://SYNC.example.test',
    'https://sync.example.test:443',
    'https://user@sync.example.test',
    'https://sync.example.test/path',
    'https://sync.example.test?invite=value',
    'https://sync.example.test#fragment',
  ])('rejects unsafe or normalized server origins: %s', (serverOrigin) => {
    expect(() =>
      buildInviteEnvelope({
        invitationToken: INVITATION_TOKEN,
        serverOrigin,
      }),
    ).toThrow(InviteFormatError);
  });

  it.each([
    '',
    'short',
    `hm_it_${'A'.repeat(42)}`,
    `hm_it_${'A'.repeat(42)}+`,
    `hm_it_${'A'.repeat(44)}`,
    `hm_rt_${'A'.repeat(43)}`,
    `hm_it_${'A'.repeat(42)}B`,
  ])('requires an exact 256-bit unpadded base64url invitation token', (token) => {
    expect(() =>
      buildInviteEnvelope({
        invitationToken: token,
        serverOrigin: 'https://sync.example.test',
      }),
    ).toThrow(InviteFormatError);
  });

  it.each([
    `https://sync.example.test/join?envelope=${CANONICAL_ENVELOPE}`,
    `https://sync.example.test/join/${CANONICAL_ENVELOPE}`,
    `https://sync.example.test/other#${CANONICAL_ENVELOPE}`,
    `http://sync.example.test/join#${CANONICAL_ENVELOPE}`,
    `https://other.example.test/join#${CANONICAL_ENVELOPE}`,
  ])('rejects a landing link that moves or rebinds the capability', (url) => {
    expect(() => parseLandingInviteUrl(url)).toThrow(InviteFormatError);
  });

  it('uses a capability-free passive Obsidian URI and rejects every parameter', () => {
    expect(PASSIVE_OBSIDIAN_JOIN_URL).toBe('obsidian://havemind-join');
    expect(parsePassiveObsidianJoinUrl(PASSIVE_OBSIDIAN_JOIN_URL)).toEqual({
      action: 'havemind-join',
    });

    for (const unsafeUrl of [
      'obsidian://havemind-join/',
      'obsidian://havemind-join?token=value',
      'obsidian://havemind-join?envelope=value',
      'obsidian://havemind-join#value',
      'obsidian://HAVEMIND-JOIN',
      'obsidian://havemind-join/path',
    ]) {
      expect(() => parsePassiveObsidianJoinUrl(unsafeUrl)).toThrow(
        InviteFormatError,
      );
    }
  });

  it('accepts only the parameter-free protocol callback shape', () => {
    expect(
      isSafePassiveJoinProtocolData({ action: 'havemind-join' }),
    ).toBe(true);

    for (const data of [
      { action: 'havemind-join', token: INVITATION_TOKEN },
      { action: 'havemind-join', envelope: CANONICAL_ENVELOPE },
      { action: 'havemind-join', secret: 'value' },
      { action: 'havemind-join', harmless: 'value' },
      { action: 'other' },
    ]) {
      expect(isSafePassiveJoinProtocolData(data)).toBe(false);
    }
  });

  it('never repeats rejected capability material in an error', () => {
    const rejected = `${CANONICAL_ENVELOPE}=${INVITATION_TOKEN}`;

    try {
      parseInviteEnvelope(rejected);
      throw new Error('Expected parsing to fail.');
    } catch (error) {
      expect(String(error)).not.toContain(INVITATION_TOKEN);
      expect(String(error)).not.toContain(CANONICAL_ENVELOPE);
    }
  });
});

function encodeRawJson(json: string): string {
  const bytes = new TextEncoder().encode(json);
  const binary = String.fromCharCode(...bytes);
  return `v1.${btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')}`;
}

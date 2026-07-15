export const INVITE_ENVELOPE_VERSION = 1 as const;
export const PASSIVE_OBSIDIAN_JOIN_URL = 'obsidian://havemind-join' as const;

const ENVELOPE_PREFIX = 'v1.';
const ENVELOPE_PATTERN = /^v1\.([A-Za-z0-9_-]+)$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const INVITATION_PREFIX = 'hm_it_';
const TOKEN_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TOKEN_BYTE_LENGTH = 32;
const MAX_ENVELOPE_LENGTH = 1_024;

export interface InviteEnvelopeInput {
  invitationToken: string;
  serverOrigin: string;
}

export interface InviteEnvelope extends InviteEnvelopeInput {
  version: typeof INVITE_ENVELOPE_VERSION;
}

export class InviteFormatError extends Error {
  readonly code = 'invalid-invitation-envelope';
  override readonly name = 'InviteFormatError';

  constructor() {
    super('The secure invitation has an invalid or non-canonical format.');
  }
}

export function buildInviteEnvelope(input: InviteEnvelopeInput): string {
  assertCanonicalHttpsOrigin(input.serverOrigin);
  assertInvitationToken(input.invitationToken);
  return encodeEnvelope({
    version: INVITE_ENVELOPE_VERSION,
    serverOrigin: input.serverOrigin,
    invitationToken: input.invitationToken,
  });
}

export function parseInviteEnvelope(value: string): InviteEnvelope {
  if (value.length > MAX_ENVELOPE_LENGTH) throw new InviteFormatError();
  const match = ENVELOPE_PATTERN.exec(value);
  const payload = match?.[1];
  if (!payload) throw new InviteFormatError();

  let decoded: string;
  try {
    const bytes = decodeBase64Url(payload);
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InviteFormatError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new InviteFormatError();
  }

  const envelope = parseEnvelopeRecord(parsed);
  if (encodeEnvelope(envelope) !== value) throw new InviteFormatError();
  return envelope;
}

export function buildLandingInviteUrl(envelope: string): string {
  const parsed = parseInviteEnvelope(envelope);
  return `${parsed.serverOrigin}/join#${envelope}`;
}

export function parseLandingInviteUrl(value: string): InviteEnvelope {
  if (value.length > MAX_ENVELOPE_LENGTH + 256) {
    throw new InviteFormatError();
  }
  const fragmentIndex = value.indexOf('#');
  if (fragmentIndex < 0 || value.indexOf('#', fragmentIndex + 1) >= 0) {
    throw new InviteFormatError();
  }

  const envelope = value.slice(fragmentIndex + 1);
  const parsed = parseInviteEnvelope(envelope);
  if (buildLandingInviteUrl(envelope) !== value) {
    throw new InviteFormatError();
  }
  return parsed;
}

/**
 * Obsidian's public protocol callback exposes query parameters but not URL
 * fragments. The URI therefore opens only the local paste/import wizard; a
 * capability must never be added to this URI until a public fragment handoff
 * exists.
 */
export function parsePassiveObsidianJoinUrl(
  value: string,
): Readonly<{ action: 'havemind-join' }> {
  if (value !== PASSIVE_OBSIDIAN_JOIN_URL) throw new InviteFormatError();
  return { action: 'havemind-join' };
}

export function isSafePassiveJoinProtocolData(
  data: Readonly<Record<string, unknown>>,
): boolean {
  const keys = Object.keys(data);
  return keys.length === 1 && data.action === 'havemind-join';
}

function parseEnvelopeRecord(value: unknown): InviteEnvelope {
  if (!isRecord(value)) throw new InviteFormatError();
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes('version') ||
    !keys.includes('serverOrigin') ||
    !keys.includes('invitationToken') ||
    value.version !== INVITE_ENVELOPE_VERSION ||
    typeof value.serverOrigin !== 'string' ||
    typeof value.invitationToken !== 'string'
  ) {
    throw new InviteFormatError();
  }

  assertCanonicalHttpsOrigin(value.serverOrigin);
  assertInvitationToken(value.invitationToken);
  return {
    version: INVITE_ENVELOPE_VERSION,
    serverOrigin: value.serverOrigin,
    invitationToken: value.invitationToken,
  };
}

function encodeEnvelope(envelope: InviteEnvelope): string {
  const canonicalJson = JSON.stringify({
    version: envelope.version,
    serverOrigin: envelope.serverOrigin,
    invitationToken: envelope.invitationToken,
  });
  return `${ENVELOPE_PREFIX}${encodeBase64Url(
    new TextEncoder().encode(canonicalJson),
  )}`;
}

function assertCanonicalHttpsOrigin(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InviteFormatError();
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.origin !== value
  ) {
    throw new InviteFormatError();
  }
}

function assertInvitationToken(value: string): void {
  if (!value.startsWith(INVITATION_PREFIX)) throw new InviteFormatError();
  const payload = value.slice(INVITATION_PREFIX.length);
  if (!TOKEN_PAYLOAD_PATTERN.test(payload)) throw new InviteFormatError();

  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(payload);
  } catch {
    throw new InviteFormatError();
  }
  if (
    decoded.byteLength !== TOKEN_BYTE_LENGTH ||
    encodeBase64Url(decoded) !== payload
  ) {
    throw new InviteFormatError();
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new InviteFormatError();
  }
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw new InviteFormatError();
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

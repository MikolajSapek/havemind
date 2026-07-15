import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  HAVEMIND_SERVICE_ID,
  MAX_SUPPORTED_PROTOCOL_MINOR,
  MIN_SUPPORTED_PROTOCOL_MINOR,
  PROTOCOL_MAJOR_VERSION,
  PROTOCOL_MINOR_VERSION,
  PROTOCOL_VERSION,
  discoveryDocumentSchema,
  negotiateProtocolVersion,
  protocolVersionRangeSchema,
} from './version.js';

describe('protocol version contracts', () => {
  it('exports stable pilot version constants', () => {
    expect(HAVEMIND_SERVICE_ID).toBe('havemind');
    expect(PROTOCOL_VERSION).toEqual({
      major: PROTOCOL_MAJOR_VERSION,
      minor: PROTOCOL_MINOR_VERSION,
    });
    expect(MIN_SUPPORTED_PROTOCOL_MINOR).toBeLessThanOrEqual(
      PROTOCOL_MINOR_VERSION,
    );
    expect(MAX_SUPPORTED_PROTOCOL_MINOR).toBeGreaterThanOrEqual(
      PROTOCOL_MINOR_VERSION,
    );
  });

  it('rejects an inverted supported minor range', () => {
    const parsed = protocolVersionRangeSchema.safeParse({
      major: 1,
      minMinor: 4,
      maxMinor: 2,
    });

    expect(parsed.success).toBe(false);
  });

  it('negotiates the highest shared minor in the same major', () => {
    expect(
      negotiateProtocolVersion(
        { major: 1, minMinor: 0, maxMinor: 3 },
        { major: 1, minMinor: 2, maxMinor: 5 },
      ),
    ).toEqual({ major: 1, minor: 3 });
  });

  it('fails closed when major versions or minor ranges do not overlap', () => {
    expect(
      negotiateProtocolVersion(
        { major: 1, minMinor: 0, maxMinor: 3 },
        { major: 2, minMinor: 0, maxMinor: 3 },
      ),
    ).toBeNull();
    expect(
      negotiateProtocolVersion(
        { major: 1, minMinor: 0, maxMinor: 1 },
        { major: 1, minMinor: 2, maxMinor: 3 },
      ),
    ).toBeNull();
    expect(
      negotiateProtocolVersion(
        { major: 1, minMinor: 3, maxMinor: 2 },
        { major: 1, minMinor: 0, maxMinor: 3 },
      ),
    ).toBeNull();
  });

  it('validates a strict HTTPS discovery document', () => {
    const document = discoveryDocumentSchema.parse({
      service: 'havemind',
      name: 'Sapserver Havemind',
      apiBaseUrl: 'https://havemind.example.test/api/v1',
      protocol: { major: 1, minMinor: 0, maxMinor: 2 },
      authMethods: ['opaque-token'],
      capabilities: ['markdown-sync-v1', 'revision-dag-v1'],
    });

    expect(document.service).toBe(HAVEMIND_SERVICE_ID);
  });

  it.each([
    {
      service: 'other',
      name: 'Server',
      apiBaseUrl: 'https://example.test/api/v1',
      protocol: { major: 1, minMinor: 0, maxMinor: 1 },
      authMethods: ['opaque-token'],
      capabilities: [],
    },
    {
      service: 'havemind',
      name: 'Server',
      apiBaseUrl: 'http://example.test/api/v1',
      protocol: { major: 1, minMinor: 0, maxMinor: 1 },
      authMethods: ['opaque-token'],
      capabilities: [],
    },
    {
      service: 'havemind',
      name: 'Server',
      apiBaseUrl: 'https://example.test/api/v1?invite=secret',
      protocol: { major: 1, minMinor: 0, maxMinor: 1 },
      authMethods: ['opaque-token'],
      capabilities: [],
    },
    {
      service: 'havemind',
      name: 'Server',
      apiBaseUrl: 'https://example.test/api/v1',
      protocol: { major: 1, minMinor: 0, maxMinor: 1 },
      authMethods: ['opaque-token'],
      capabilities: [],
      unexpected: true,
    },
  ])('rejects an unsafe or non-canonical discovery document', (input) => {
    expect(discoveryDocumentSchema.safeParse(input).success).toBe(false);
  });

  it('exports stable machine-readable error codes', () => {
    expect(ERROR_CODES.HEAD_SET_CHANGED).toBe('HEAD_SET_CHANGED');
    expect(ERROR_CODES.REVISION_ID_REUSE).toBe('REVISION_ID_REUSE');
    expect(ERROR_CODES.INCOMPATIBLE_PROTOCOL).toBe(
      'INCOMPATIBLE_PROTOCOL',
    );
  });
});

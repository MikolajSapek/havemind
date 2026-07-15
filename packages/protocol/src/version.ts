import { z } from 'zod';

export const HAVEMIND_SERVICE_ID = 'havemind' as const;

export const PROTOCOL_MAJOR_VERSION = 1 as const;
export const PROTOCOL_MINOR_VERSION = 0 as const;
export const MIN_SUPPORTED_PROTOCOL_MINOR = 0 as const;
export const MAX_SUPPORTED_PROTOCOL_MINOR = 0 as const;

export const PROTOCOL_VERSION = Object.freeze({
  major: PROTOCOL_MAJOR_VERSION,
  minor: PROTOCOL_MINOR_VERSION,
});

export const ERROR_CODES = Object.freeze({
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  FORBIDDEN: 'FORBIDDEN',
  HEAD_SET_CHANGED: 'HEAD_SET_CHANGED',
  INCOMPATIBLE_PROTOCOL: 'INCOMPATIBLE_PROTOCOL',
  INVALID_INVITATION: 'INVALID_INVITATION',
  INVALID_REQUEST: 'INVALID_REQUEST',
  KEY_EPOCH_REQUIRED: 'KEY_EPOCH_REQUIRED',
  MISSING_PARENT: 'MISSING_PARENT',
  NOT_FOUND: 'NOT_FOUND',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  REVISION_ID_REUSE: 'REVISION_ID_REUSE',
  UNSUPPORTED_SEMANTICS: 'UNSUPPORTED_SEMANTICS',
} as const);

export type ProtocolErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const protocolVersionSchema = z
  .object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
  })
  .strict();

export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;

export const protocolVersionRangeSchema = z
  .object({
    major: z.number().int().nonnegative(),
    minMinor: z.number().int().nonnegative(),
    maxMinor: z.number().int().nonnegative(),
  })
  .strict()
  .refine((range) => range.minMinor <= range.maxMinor, {
    message: 'minMinor must not exceed maxMinor',
    path: ['minMinor'],
  });

export type ProtocolVersionRange = z.infer<
  typeof protocolVersionRangeSchema
>;

const httpsApiBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', {
    message: 'apiBaseUrl must use HTTPS',
  })
  .refine(
    (value) => {
      const url = new URL(value);
      return (
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
      );
    },
    {
      message:
        'apiBaseUrl must not contain credentials, a query or a fragment',
    },
  );

const capabilitySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]*$/u);

export const discoveryDocumentSchema = z
  .object({
    service: z.literal(HAVEMIND_SERVICE_ID),
    name: z.string().trim().min(1).max(80),
    apiBaseUrl: httpsApiBaseUrlSchema,
    protocol: protocolVersionRangeSchema,
    authMethods: z.array(z.enum(['opaque-token'])).min(1),
    capabilities: z.array(capabilitySchema).max(64),
  })
  .strict();

export type DiscoveryDocument = z.infer<typeof discoveryDocumentSchema>;

export function negotiateProtocolVersion(
  clientRange: ProtocolVersionRange,
  serverRange: ProtocolVersionRange,
): ProtocolVersion | null {
  const parsedClient = protocolVersionRangeSchema.safeParse(clientRange);
  const parsedServer = protocolVersionRangeSchema.safeParse(serverRange);

  if (!parsedClient.success || !parsedServer.success) {
    return null;
  }

  if (parsedClient.data.major !== parsedServer.data.major) {
    return null;
  }

  const minimum = Math.max(
    parsedClient.data.minMinor,
    parsedServer.data.minMinor,
  );
  const maximum = Math.min(
    parsedClient.data.maxMinor,
    parsedServer.data.maxMinor,
  );

  if (minimum > maximum) {
    return null;
  }

  return { major: parsedClient.data.major, minor: maximum };
}

/**
 * The branded-token and hashing primitives the connect and owner-action paths
 * mint credentials with. Zero home-grown cryptography: every value comes from
 * `crypto.getRandomValues` or `crypto.subtle.digest`, base64url-encoded to match
 * the server's own token grammar, and the SHA-256 helper mirrors the server's
 * `hashToken` exactly so a locally-hashed refresh token binds on the first try.
 */

function generateBrandedToken(prefix: string): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  return `${prefix}${base64url}`;
}

export function generateRefreshTokenValue(): string {
  return generateBrandedToken('hm_rt_');
}

/**
 * A server-recognised refresh rotation id (`hm_ri_…`). The server rejects the
 * rotation unless `rotationId` parses as this branded token — a plain UUID here
 * caused `/auth/refresh` to 401 on every call (F8-02f bug A).
 */
export function generateRotationIdValue(): string {
  return generateBrandedToken('hm_ri_');
}

/** SHA-256 hex of a token string, matching the server's `hashToken`. */
export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Bytes handed to `String.fromCharCode` at once, inside the argument limit a whole-array spread would breach. */
const ENCODE_SLICE = 8192;

/** Characters handed to `atob` at once, a multiple of 4 so each slice is base64 on its own. */
const DECODE_SLICE = 4 * 8192;

/**
 * Base64 of raw bytes, binary-safe (every byte 0x00 to 0xFF preserved). Built a
 * slice at a time: per-byte concatenation blocks the main thread for seconds on
 * a 25 MB attachment, and a phone is several times slower.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += ENCODE_SLICE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + ENCODE_SLICE),
    );
  }
  return btoa(binary);
}

/**
 * Bytes of canonical base64, decoded straight into a buffer of exactly the right
 * size instead of through a second full-size string. Throws what `atob` throws.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(Math.floor(((base64.length - padding) * 3) / 4));
  let written = 0;
  for (let offset = 0; offset < base64.length; offset += DECODE_SLICE) {
    const binary = atob(base64.slice(offset, offset + DECODE_SLICE));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[written + index] = binary.charCodeAt(index);
    }
    written += binary.length;
  }
  return bytes;
}

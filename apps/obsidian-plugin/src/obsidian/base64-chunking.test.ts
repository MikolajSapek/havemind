/**
 * Encoding a large attachment must not build a 25 MB string one character at a
 * time.
 *
 * `bytesToBase64` ran `binary += String.fromCharCode(byte)` per byte. Measured
 * on a laptop, that is 1.2 seconds of blocked main thread for a file at
 * `MAX_BINARY_FILE_BYTES` (25 MB), and a phone is several times slower. The
 * thread is blocked, so the UI cannot repaint and taps do nothing: exactly the
 * freeze reported on mobile.
 *
 * Chunking through `String.fromCharCode(...chunk)` is roughly twice as fast and
 * produces identical output. The chunk stays small enough to pass as arguments
 * without risking a call-stack overflow on a large attachment.
 */

import { describe, expect, it } from 'vitest';

import { bytesToBase64 } from './vault-adapter';

/** The per-byte version, kept as the oracle the fast path must match. */
function naive(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('bytesToBase64', () => {
  it('matches a per-byte encoder exactly, across every byte value', () => {
    // 0x00-0xFF in order, then repeated, so a chunk boundary lands mid-pattern.
    const bytes = new Uint8Array(9000).map((_, i) => i % 256);
    expect(bytesToBase64(bytes)).toBe(naive(bytes));
  });

  it('handles an empty input', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });

  it('handles a length that is not a multiple of the chunk size', () => {
    // Padding is computed over the whole input, so a ragged tail is where a
    // chunked encoder would break if it padded per chunk.
    for (const size of [1, 2, 3, 8191, 8192, 8193, 16385]) {
      const bytes = new Uint8Array(size).map((_, i) => (i * 7) % 256);
      expect(bytesToBase64(bytes), `size ${size}`).toBe(naive(bytes));
    }
  });

  it('does not blow the call stack on a large attachment', () => {
    // Spreading a whole 4 MB array into fromCharCode would overflow; the point
    // of chunking is that it cannot.
    const bytes = new Uint8Array(4 * 1024 * 1024).map((_, i) => i % 256);
    expect(() => bytesToBase64(bytes)).not.toThrow();
  });

  it('encodes a large attachment faster than the per-byte version', () => {
    // RELATIVE, not a wall-clock budget: an absolute threshold passes alone and
    // fails under a loaded suite, which makes it a flake rather than a guard.
    // Both encoders run here, on the same machine at the same moment, so the
    // comparison holds whatever else is running.
    const bytes = new Uint8Array(4 * 1024 * 1024).map((_, i) => i % 256);

    const naiveStart = performance.now();
    naive(bytes);
    const naiveMs = performance.now() - naiveStart;

    const chunkedStart = performance.now();
    bytesToBase64(bytes);
    const chunkedMs = performance.now() - chunkedStart;

    // Measured roughly 2x on a laptop; 0.8 leaves room for noise while still
    // failing outright if the per-byte concatenation comes back.
    expect(chunkedMs).toBeLessThan(naiveMs * 0.8);
  });
});

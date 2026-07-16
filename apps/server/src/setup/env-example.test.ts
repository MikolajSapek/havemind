import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  parseAccessToken,
  parsePairingToken,
  parseRefreshToken,
} from '../auth/tokens.js';
import { parseServerConfig } from '../config.js';

// deploy/.env.example lives at the repository root, four levels up from here.
const ENV_EXAMPLE_PATH = fileURLToPath(
  new URL('../../../../deploy/.env.example', import.meta.url),
);

// Any Havemind credential is one of these opaque token families, or a long
// high-entropy blob. None of them belongs in a checked-in template.
const TOKEN_PREFIX_PATTERN = /hm_(?:at|rt|pt|it|ri)_/u;
const LONG_HEX_PATTERN = /\b[0-9a-f]{32,}\b/iu;
const LONG_BASE64_PATTERN = /[A-Za-z0-9_-]{40,}/u;

interface EnvEntry {
  readonly key: string;
  readonly value: string;
}

function parseEnvFile(contents: string): readonly EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    entries.push({
      key: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
    });
  }
  return entries;
}

describe('deploy/.env.example (AC: no working secret)', () => {
  const contents = readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const entries = parseEnvFile(contents);

  it('defines at least the required API base URL', () => {
    expect(entries.some((entry) => entry.key === 'HAVEMIND_API_BASE_URL')).toBe(
      true,
    );
  });

  it('contains no value that looks like a Havemind token or secret', () => {
    for (const entry of entries) {
      expect(TOKEN_PREFIX_PATTERN.test(entry.value)).toBe(false);
      expect(LONG_HEX_PATTERN.test(entry.value)).toBe(false);
      expect(LONG_BASE64_PATTERN.test(entry.value)).toBe(false);
    }
  });

  it('rejects every value when used as a real token (connection attempt)', () => {
    for (const entry of entries) {
      expect(() => parseAccessToken(entry.value)).toThrow();
      expect(() => parseRefreshToken(entry.value)).toThrow();
      expect(() => parsePairingToken(entry.value)).toThrow();
    }
  });

  it('parses as a valid, non-secret server configuration', () => {
    const env: Record<string, string> = {};
    for (const entry of entries) {
      env[entry.key] = entry.value;
    }
    // The template must yield a usable config with no credentials embedded.
    expect(() => parseServerConfig(env)).not.toThrow();
  });
});

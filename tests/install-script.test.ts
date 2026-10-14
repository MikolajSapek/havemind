/**
 * deploy/install.sh (plans/013), exercised in its dry-run mode with stub
 * `docker` and `tailscale` on PATH: what it would do, and what it must never do.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', 'deploy', 'install.sh');
const source = readFileSync(SCRIPT, 'utf8');

function dryRun(): string {
  const bin = mkdtempSync(join(tmpdir(), 'hm-install-bin-'));
  for (const name of ['docker', 'tailscale']) {
    const stub = join(bin, name);
    writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    chmodSync(stub, 0o755);
  }
  return execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAVEMIND_DRY_RUN: '1',
      HAVEMIND_YES: '1',
      HAVEMIND_DNS_NAME: 'box.your-tailnet.ts.net.',
      HAVEMIND_HOME: mkdtempSync(join(tmpdir(), 'hm-install-home-')),
      HAVEMIND_VERSION: '9.9.9',
    },
  });
}

describe('install.sh', () => {
  it('starts the published image and serves it inside the tailnet', () => {
    const out = dryRun();
    expect(out).toContain('Havemind 9.9.9');
    expect(out).toMatch(/compose --project-directory \S+ pull/);
    expect(out).toMatch(/compose --project-directory \S+ up -d/);
    expect(out).toMatch(/tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:8787/);
    expect(out).toContain('https://box.your-tailnet.ts.net inside your tailnet');
    expect(out).toMatch(/setup --owner \S+ --vault/);
  });

  it('never opens the server to the public internet', () => {
    const code = source.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/\bfunnel\b/i);
    expect(source).toMatch(/ports: \["127\.0\.0\.1:\$\{PORT\}:8787"\]/);
    expect(source).not.toMatch(/0\.0\.0\.0/);
  });

  it('asks before installing anything, unless told yes in advance', () => {
    for (const what of ['Docker is not installed', 'Tailscale is not installed']) {
      const at = source.indexOf(what);
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at - 20, at)).toContain('ask');
    }
  });
});

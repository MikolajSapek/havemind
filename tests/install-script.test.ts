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

const COMPOSE_OK = '[ "$1 $2" = "compose version" ] && echo "Docker Compose version v2.29.1"\n';

function dryRun(dockerStub = `#!/bin/sh\n${COMPOSE_OK}exit 0\n`, extraEnv: Record<string, string> = {}): string {
  const bin = mkdtempSync(join(tmpdir(), 'hm-install-bin-'));
  for (const [name, body] of [['docker', dockerStub], ['tailscale', '#!/bin/sh\nexit 0\n']] as const) {
    const stub = join(bin, name);
    writeFileSync(stub, body);
    chmodSync(stub, 0o755);
  }
  return execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAVEMIND_DRY_RUN: '1',
      HAVEMIND_YES: '1',
      HAVEMIND_DNS_NAME: 'box.your-tailnet.ts.net.',
      HAVEMIND_HOME: mkdtempSync(join(tmpdir(), 'hm-install-home-')),
      HAVEMIND_VERSION: '9.9.9',
      ...extraEnv,
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

  it('gives uid 1000 its data and backup folders before the server starts', () => {
    // A fresh named volume is root-owned; the server (uid 1000, no
    // capabilities) then fails with "unable to open database file" (AWS, 1.9.0).
    const out = dryRun();
    const chown = out.search(/--entrypoint chown -v havemind-install_havemind-data:\/data -v \S+:\/backups -v \S+:\/agents -v \S+:\/agent-secrets \S+ -R 1000:1000 \/data \/backups \/agents \/agent-secrets/);
    expect(chown).toBeGreaterThan(-1);
    expect(chown).toBeLessThan(out.search(/ up -d/));
  });

  it('sets the owner up again when an earlier run stopped before setup', () => {
    // compose.yaml existed, so the re-run took the update path and called
    // rotate-pairing on a server with no owner (AWS, 1.9.0).
    const at = source.indexOf('step "Your vault"');
    const vault = source.slice(at);
    expect(vault).toMatch(/if \[ ! -f "\$OWNER_MARK" \]; then/);
    expect(vault.indexOf('touch "$OWNER_MARK"')).toBeGreaterThan(vault.indexOf(' setup --owner'));
  });

  it('runs the agents service next to the server, ready for one-click agents (plan 015)', () => {
    expect(source).toMatch(/^ {2}havemind-agents:$/m);
    expect(source).not.toMatch(/profiles: \[agents\]/);
    expect(source).toMatch(/agent\/havemind-agent\.mjs", "run"/);
    // The model key lives in its own folder: never in the data volume or backups.
    expect(source).toMatch(/- \.\/agent-secrets:\/agent-secrets$/m);
    expect(source).toMatch(/- \.\/agent-secrets:\/agent-secrets:ro$/m);
    expect(source).toMatch(/HAVEMIND_AGENT_SECRETS_DIR: \/agent-secrets/);
  });

  it('makes the agents service token once, only on the server', () => {
    expect(source).toMatch(/HAVEMIND_AGENT_SERVICE_TOKEN=/);
    expect(source).toMatch(/grep -q '\^HAVEMIND_AGENT_SERVICE_TOKEN=' "\$\{HOME_DIR\}\/\.env"/);
  });

  it('never rewrites an existing .env, which may hold the model key', () => {
    expect(source).toMatch(/if \[ ! -f "\$\{HOME_DIR\}\/\.env" \]; then/);
  });

  it('runs an image built on this machine when told to, without pulling', () => {
    // For testing an unreleased build, or a server with no registry access.
    const out = dryRun(undefined, { HAVEMIND_IMAGE: 'havemind-local:test' });
    expect(out).not.toMatch(/ pull$/m);
    expect(out).toContain('havemind-local:test');
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

  it('refuses to take over a Havemind stack it did not install', () => {
    // A manual deploy/compose.yaml stack (project "havemind") must never be
    // recreated with the published image and a rewritten .env.
    const existing = `#!/bin/sh\n${COMPOSE_OK}[ "$1" = ps ] && echo abc123\nexit 0\n`;
    let failure: { stderr?: string; status?: number } = {};
    try {
      dryRun(existing);
    } catch (error) {
      failure = error as { stderr?: string; status?: number };
    }
    expect(failure.status).toBe(1);
    expect(failure.stderr).toMatch(/already runs Havemind/);
  });

  it('uses its own Compose project, never the manual stack\'s', () => {
    expect(source).toMatch(/^name: havemind-install$/m);
  });

  it('runs to the end when piped into bash and a command reads stdin', () => {
    // `curl … | bash` feeds the script on stdin; `docker compose exec` read the
    // rest of it, so bash stopped after "Your vault" with exit 0 (AWS, 1.9.1).
    const bin = mkdtempSync(join(tmpdir(), 'hm-install-bin-'));
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\n${COMPOSE_OK}cat >/dev/null\nexit 0\n`);
    writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'docker'), 0o755);
    chmodSync(join(bin, 'tailscale'), 0o755);
    const out = execFileSync('bash', [], {
      encoding: 'utf8',
      input: source,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HAVEMIND_DRY_RUN: '1',
        HAVEMIND_YES: '1',
        HAVEMIND_DNS_NAME: 'box.your-tailnet.ts.net',
        HAVEMIND_HOME: mkdtempSync(join(tmpdir(), 'hm-install-home-')),
      },
    });
    expect(out).toContain('==> Done');
  });

  it('never sources os-release into its own shell', () => {
    // /etc/os-release sets VERSION; sourcing it at top level replaced the image
    // tag with "24.04.5 LTS (Noble Numbat)" on Ubuntu (CI, 1.9.0).
    expect(source).not.toMatch(/^\s*\. \/etc\/os-release\s*$/m);
  });

  it('never loses the single-use code when it cannot find the one line', () => {
    const at = source.indexOf('step "Done"');
    expect(source.slice(at)).toMatch(/\$OUTPUT/);
  });

  describe('unattended re-run (item 17)', () => {
    const rerun = (extra: Record<string, string>): string => {
      const home = mkdtempSync(join(tmpdir(), 'hm-install-home-'));
      writeFileSync(join(home, 'compose.yaml'), '');
      writeFileSync(join(home, '.owner-ready'), '');
      return dryRun(undefined, { HAVEMIND_HOME: home, ...extra });
    };

    it('does not rotate the owner code under HAVEMIND_YES=1 and says how to get one', () => {
      const out = rerun({});
      expect(out).not.toContain('rotate-pairing');
      expect(out).toContain('HAVEMIND_ROTATE=1');
    });

    it('rotates when HAVEMIND_ROTATE=1 is also set', () => {
      expect(rerun({ HAVEMIND_ROTATE: '1' })).toContain('rotate-pairing');
    });
  });

  it('locks down the files it writes before the first one exists (item 18)', () => {
    expect(source).toMatch(/^umask 077$/m);
    expect(source.indexOf('umask 077')).toBeLessThan(source.indexOf('cat > "${HOME_DIR}/.env"'));
    expect(source).toMatch(/chmod 700 "\$\{HOME_DIR\}\/backups" "\$\{HOME_DIR\}\/agents" "\$\{HOME_DIR\}\/agent-secrets"/);
  });

  it('does not hide a failed download behind a pipe (item 19a)', () => {
    expect(source).not.toMatch(/sh -c "curl/);
    expect(source).toMatch(/curl -fsSL https:\/\/get\.docker\.com -o "\$tmp"/);
    expect(source).toMatch(/curl -fsSL https:\/\/tailscale\.com\/install\.sh -o "\$tmp"/);
  });

  describe('docker compose plugin (item 19b)', () => {
    const withCompose = (reply: string): { status?: number; stderr?: string } | string => {
      try {
        return dryRun(`#!/bin/sh\n${reply}\nexit 0\n`);
      } catch (error) {
        return error as { status?: number; stderr?: string };
      }
    };

    it('stops with install help when the plugin is missing', () => {
      const r = withCompose('[ "$1" = compose ] && exit 1') as { status?: number; stderr?: string };
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/docker compose plugin/i);
    });

    it('stops when Compose is older than 2.24', () => {
      const r = withCompose('[ "$1" = compose ] && echo "Docker Compose version v2.23.3"') as { status?: number; stderr?: string };
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/2\.24/);
    });

    it('accepts 2.24 and newer, with or without a v prefix', () => {
      expect(withCompose('[ "$1" = compose ] && echo "Docker Compose version 2.24.0-desktop.1"')).toContain('==> Done');
      expect(withCompose('[ "$1" = compose ] && echo "Docker Compose version v3.0.1"')).toContain('==> Done');
    });
  });

  it('tests for a usable terminal by opening it, not by -r (item 19c)', () => {
    expect(source).not.toMatch(/-r \/dev\/tty/);
    expect(source).toMatch(/\{ : >\/dev\/tty; \} 2>\/dev\/null/);
  });

  it('runs the Docker and Tailscale install scripts with a normal umask', () => {
    // umask 077 protects the installer's own secret files; apt keyrings and
    // sources written under it are unreadable to apt's own user, which breaks
    // the one-command install on a clean Debian or Ubuntu.
    const runs = source.split('\n').filter((l) => /^\s*run .*"\$tmp"\s*$/u.test(l) && !l.includes('curl'));
    expect(runs).toHaveLength(2);
    for (const line of runs) expect(line).toMatch(/umask 022 && exec sh "\$0"/u);
  });
});

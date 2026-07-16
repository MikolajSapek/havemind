// `npm run compose:smoke` — configuration smoke test for the hardened Compose
// package (issue F7-02 / task T030).
//
// Two layers of verification:
//   1. Static analysis of deploy/compose.yaml + apps/server/Dockerfile via the
//      dependency-free analyzer (runs everywhere, incl. macOS without Docker).
//   2. If a Docker CLI is present, the authoritative `docker compose config`
//      render is grepped for any wildcard bind (the exact AC method:
//      `docker compose config | grep -c '0.0.0.0'` must be 0).
//
// Exit 0 = green, exit 1 = at least one violation.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { analyzeCompose } from './lib/compose-checks.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const composePath = `${repoRoot}deploy/compose.yaml`;
const dockerfilePath = `${repoRoot}apps/server/Dockerfile`;
const envFilePath = `${repoRoot}deploy/.env.example`;

function fail(messages) {
  console.error('compose:smoke FAILED');
  for (const message of messages) {
    console.error(`  - ${message}`);
  }
  process.exit(1);
}

function dockerAvailable() {
  const probe = spawnSync('docker', ['compose', 'version'], {
    stdio: 'ignore',
  });
  return probe.status === 0;
}

function runDockerConfigChecks() {
  const rendered = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      composePath,
      '--env-file',
      envFilePath,
      'config',
    ],
    { encoding: 'utf8' },
  );

  if (rendered.status !== 0) {
    return [
      `docker compose config failed: ${(rendered.stderr ?? '').trim() || 'unknown error'}`,
    ];
  }

  const violations = [];
  const wildcardCount = (rendered.stdout.match(/0\.0\.0\.0/g) ?? []).length;
  if (wildcardCount > 0) {
    violations.push(
      `docker compose config exposes 0.0.0.0 (${wildcardCount} occurrence(s))`,
    );
  }

  // Re-analyse the rendered document for good measure.
  const dockerfileText = readFileSync(dockerfilePath, 'utf8');
  const rerun = analyzeCompose({
    composeText: rendered.stdout,
    dockerfileText,
  });
  violations.push(...rerun.violations);
  return violations;
}

function main() {
  const composeText = readFileSync(composePath, 'utf8');
  const dockerfileText = readFileSync(dockerfilePath, 'utf8');

  const violations = [...analyzeCompose({ composeText, dockerfileText }).violations];

  let mode = 'static';
  if (dockerAvailable()) {
    mode = 'static + docker compose config';
    violations.push(...runDockerConfigChecks());
  }

  if (violations.length > 0) {
    fail(violations);
  }

  console.log(`compose:smoke PASSED (${mode})`);
  console.log('  - no port bound outside 127.0.0.1');
  console.log('  - base image pinned by @sha256 digest');
  console.log('  - non-root, read-only, cap-drop ALL, no-new-privileges, init, tmpfs');
}

main();

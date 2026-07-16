import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error — tooling module authored in plain ESM (.mjs), no d.ts.
import { analyzeCompose } from '../../scripts/lib/compose-checks.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, `file://${repoRoot}`), 'utf8');
}

describe('analyzeCompose — real hardened package', () => {
  it('reports no violations for the shipped compose.yaml and Dockerfile', async () => {
    const composeText = await read('deploy/compose.yaml');
    const dockerfileText = await read('apps/server/Dockerfile');

    const { violations } = analyzeCompose({ composeText, dockerfileText });

    expect(violations).toEqual([]);
  });

  it('finds no literal 0.0.0.0 anywhere in the shipped compose.yaml', async () => {
    const composeText = await read('deploy/compose.yaml');
    const matches = composeText.match(/0\.0\.0\.0/g) ?? [];
    expect(matches).toHaveLength(0);
  });
});

describe('analyzeCompose — catches unsafe configuration', () => {
  const badCompose = [
    'name: bad',
    'services:',
    '  havemind-server:',
    '    image: node:22',
    '    privileged: true',
    '    cap_add:',
    '      - NET_ADMIN',
    '    ports:',
    '      - "0.0.0.0:8787:8787"',
    '      - "9000:9000"',
    '    volumes:',
    '      - /var/run/docker.sock:/var/run/docker.sock',
    '',
  ].join('\n');

  const badDockerfile = ['FROM node:22-bookworm-slim', 'CMD ["node"]'].join(
    '\n',
  );

  it('flags a public bind, missing host IP, privileged, cap_add and docker.sock', () => {
    const { violations } = analyzeCompose({
      composeText: badCompose,
      dockerfileText: badDockerfile,
    });

    const joined = violations.join('\n');
    expect(violations.length).toBeGreaterThan(0);
    expect(joined).toMatch(/0\.0\.0\.0/);
    expect(joined).toMatch(/host IP|127\.0\.0\.1/);
    expect(joined).toMatch(/privileged/);
    expect(joined).toMatch(/cap_add/);
    expect(joined).toMatch(/docker\.sock/);
  });

  it('flags a base image that is not pinned by digest', () => {
    const { violations } = analyzeCompose({
      composeText: 'services: {}\n',
      dockerfileText: badDockerfile,
    });
    expect(violations.join('\n')).toMatch(/digest|sha256/i);
  });

  it('accepts a FROM pinned via an ARG default digest', () => {
    const dockerfileText = [
      'ARG NODE_IMAGE=node:22-bookworm-slim@sha256:abc123',
      'FROM ${NODE_IMAGE} AS build',
      'FROM ${NODE_IMAGE} AS runtime',
      'CMD ["node"]',
    ].join('\n');
    const { violations } = analyzeCompose({
      composeText: 'services: {}\n',
      dockerfileText,
    });
    expect(violations.join('\n')).not.toMatch(/digest|sha256/i);
  });
});

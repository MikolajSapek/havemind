import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8'),
);

const expectedScripts = [
  'build',
  'check:workspace',
  'lint',
  'test',
  'test:coverage',
  'typecheck',
  'verify',
];

if (packageJson.private !== true) {
  throw new Error('The monorepo root must remain private.');
}

if (packageJson.license !== 'Apache-2.0') {
  throw new Error('The monorepo license must be Apache-2.0.');
}

for (const workspace of ['apps/*', 'packages/*']) {
  if (!packageJson.workspaces?.includes(workspace)) {
    throw new Error(`Missing npm workspace pattern: ${workspace}`);
  }
}

for (const script of expectedScripts) {
  if (typeof packageJson.scripts?.[script] !== 'string') {
    throw new Error(`Missing root script: ${script}`);
  }
}

for (const file of [
  'LICENSE',
  'README.md',
  'specs/001-mvp.md',
  'specs/002-public-access.md',
  'specs/003-open-source-release.md',
  'plans/001-technical-plan.md',
  'plans/002-pilot-tasks.md',
]) {
  await access(resolve(root, file));
}

console.log('Workspace metadata is consistent.');

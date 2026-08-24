import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), 'utf8'));
}

const packageJson = readJson('apps/obsidian-plugin/package.json');
const manifest = readJson('apps/obsidian-plugin/manifest.json');
const betaManifest = readJson('apps/obsidian-plugin/manifest-beta.json');
const versions = readJson('versions.json');
const version = packageJson.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Plugin version must be x.y.z; received ${version}`);
}
for (const [name, value] of [
  ['manifest.json', manifest.version],
  ['manifest-beta.json', betaManifest.version],
]) {
  if (value !== version) {
    throw new Error(`${name} has ${value}; package.json has ${version}`);
  }
}
if (manifest.minAppVersion !== betaManifest.minAppVersion) {
  throw new Error('Plugin manifests disagree on minAppVersion');
}
if (versions[version] !== manifest.minAppVersion) {
  throw new Error(
    `versions.json must map ${version} to ${manifest.minAppVersion}`,
  );
}

console.log(`Plugin release metadata is consistent for ${version}.`);

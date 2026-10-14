/**
 * Where the headless agent keeps what a plugin keeps in `data.json`: its sync
 * state, its onboarding state and its secrets, each a JSON file in the agent's
 * state folder, readable only by its owner (0600). Refresh tokens live here,
 * so nothing in this module ever logs a value.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { OnboardingSecretsPort } from '../onboarding/controller';
import type { SyncStatePersistPort } from '../runtime/sync-state';

const FILE_MODE = 0o600;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Write to a temp file, then rename: a crash mid-write never leaves half a file. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), { mode: FILE_MODE });
  await fs.rename(temp, path);
}

export interface JsonFilePort {
  load(): Promise<unknown>;
  save(data: unknown): Promise<void>;
}

export function jsonFile(dir: string, name: string): JsonFilePort {
  const path = join(dir, name);
  return { load: () => readJson(path), save: (data) => writeJson(path, data) };
}

/** The sync state, with the plugin's one-backup and corrupt-sidecar rules. */
export function syncStateFile(dir: string): SyncStatePersistPort {
  const path = join(dir, 'sync-state.json');
  const backup = `${path}.bak`;
  return {
    load: () => readJson(path),
    loadBackup: () => readJson(backup),
    async save(state) {
      try {
        await fs.copyFile(path, backup);
        await fs.chmod(backup, FILE_MODE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeJson(path, state);
    },
    async preserveCorrupt(raw, timestamp) {
      const sidecar = `${path}.corrupt-${timestamp}`;
      try {
        await fs.writeFile(sidecar, JSON.stringify(raw), { mode: FILE_MODE, flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    },
  };
}

type SecretKey = 'invitation' | 'pending' | 'refresh' | 'rejoin';

/** The onboarding secrets, one 0600 file; an empty value means "none". */
export class FileSecrets implements OnboardingSecretsPort {
  private readonly file: JsonFilePort;

  constructor(dir: string) {
    this.file = jsonFile(dir, 'secrets.json');
  }

  private async read(key: SecretKey): Promise<string | null> {
    const all = (await this.file.load()) as Record<string, unknown> | null;
    const value = all?.[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private async write(key: SecretKey, value: string): Promise<void> {
    const all = ((await this.file.load()) as Record<string, unknown> | null) ?? {};
    await this.file.save({ ...all, [key]: value });
  }

  getInvitationEnvelope = () => this.read('invitation');
  saveInvitationEnvelope = (value: string) => this.write('invitation', value);
  clearInvitationEnvelope = () => this.write('invitation', '');
  getPendingCredential = () => this.read('pending');
  savePendingCredential = (value: string) => this.write('pending', value);
  clearPendingCredential = () => this.write('pending', '');
  getRefreshToken = () => this.read('refresh');
  saveRefreshToken = (value: string) => this.write('refresh', value);
  getRejoinSecret = () => this.read('rejoin');
  saveRejoinSecret = (value: string) => this.write('rejoin', value);
}

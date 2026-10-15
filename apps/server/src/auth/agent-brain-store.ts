/**
 * Where the agents' brain lives (plans 016 and 018): one folder per vault,
 * `<secretsDir>/<vaultId>/brain.json` (provider, model, endpoint; no secret) and
 * `brain.secret` (its login). Per vault, so one vault's owner can never replace
 * or redirect another vault's agents. The agents service reads the same
 * folder and never the root.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, promises as fs, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';

export type Brain = { provider: string; model?: string | undefined; baseUrl?: string | undefined };

const BRAIN_FILE = 'brain.json';
const BRAIN_SECRET_FILE = 'brain.secret';
/** Plan 015's single-login files, from before there was a brain. */
const LEGACY_KEY_FILE = 'model.key';
const LEGACY_OAUTH_FILE = 'model.oauth';

export const brainDir = (secretsDir: string, vaultId: string): string => join(secretsDir, vaultId);

/** A random temp name, never overwriting anything, then a rename: a crash leaves the old file whole. */
async function writePrivate(file: string, text: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, text, { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/** The provider this vault's agents think with, or null when none is set or brain.json is unreadable. */
export async function readBrainKind(dir: string): Promise<string | null> {
  const saved = await fs.readFile(join(dir, BRAIN_FILE), 'utf8').catch(() => null);
  if (saved === null) return null;
  try {
    const provider = (JSON.parse(saved) as { provider?: unknown } | null)?.provider;
    return typeof provider === 'string' ? provider : null;
  } catch {
    return null;
  }
}

/**
 * Sets the brain. The secret goes first, and an old one is removed before a
 * brain without a secret is written, so a crash never pairs a new provider
 * with an old login.
 */
export async function writeBrain(dir: string, brain: Brain, secret: string | undefined): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const secretFile = join(dir, BRAIN_SECRET_FILE);
  if (secret === undefined) await fs.rm(secretFile, { force: true });
  else await writePrivate(secretFile, `${secret}\n`);
  await writePrivate(join(dir, BRAIN_FILE), `${JSON.stringify(brain)}\n`);
}

/**
 * Startup: files plan 015/016 kept in the secrets root go to the vault's own
 * folder when the server has exactly one vault. With any other count whose
 * owner they belong to is unknown, so they stay, are never read, and one
 * warning (no contents) says so.
 */
export function migrateLegacyBrain(
  database: Database.Database,
  secretsDir: string,
  warn: (message: string) => void,
): void {
  const root = (file: string) => join(secretsDir, file);
  const names = [BRAIN_FILE, BRAIN_SECRET_FILE, LEGACY_KEY_FILE, LEGACY_OAUTH_FILE];
  const present = names.filter((name) => existsSync(root(name)));
  if (present.length === 0) return;
  const vaults = database.prepare('SELECT id FROM vaults').all() as { id: string }[];
  const only = vaults.length === 1 ? vaults[0] : undefined;
  if (only === undefined) {
    warn(
      `Ignoring legacy agent brain files in the secrets directory (${present.join(', ')}): this server has ${String(vaults.length)} vaults, so they cannot be assigned to one. Set the agent model again in each vault.`,
    );
    return;
  }
  const dir = brainDir(secretsDir, only.id);
  if (existsSync(join(dir, BRAIN_FILE))) {
    warn(`Ignoring legacy agent brain files in the secrets directory (${present.join(', ')}): the vault already has its own.`);
    return;
  }
  // Which login the old files held: a brain, or plan 015's oauth token or key.
  const secretSource = existsSync(root(BRAIN_FILE))
    ? BRAIN_SECRET_FILE
    : existsSync(root(LEGACY_OAUTH_FILE))
      ? LEGACY_OAUTH_FILE
      : LEGACY_KEY_FILE;
  const brainText = existsSync(root(BRAIN_FILE))
    ? readFileSync(root(BRAIN_FILE), 'utf8')
    : `${JSON.stringify({ provider: secretSource === LEGACY_OAUTH_FILE ? 'claude-code' : 'anthropic' })}\n`;
  if (!existsSync(root(BRAIN_FILE)) && !existsSync(root(secretSource))) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Secret first, then the brain, as in writeBrain.
  if (existsSync(root(secretSource))) renameSync(root(secretSource), join(dir, BRAIN_SECRET_FILE));
  writeFileSync(join(dir, BRAIN_FILE), brainText, { flag: 'wx', mode: 0o600 });
  for (const name of names) rmSync(root(name), { force: true });
}

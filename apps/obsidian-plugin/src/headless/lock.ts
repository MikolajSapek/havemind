/**
 * One process per agent at a time (plan 014): a runner and an MCP session
 * never share an agent's state.
 *
 * The lock holds the process id and a token unique to this process. A lock
 * left by an earlier container can carry the same id as this process (ids
 * restart at 1 in every container), so "that id is alive" alone is not
 * enough: a lock with our id but not our token is stale (found live: after a
 * restart every agent was skipped as busy, in silence).
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const OWN_TOKEN = randomBytes(8).toString('hex');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(stateDir: string): Promise<(() => Promise<void>) | null> {
  const file = join(stateDir, 'lock');
  const mine = `${process.pid}:${OWN_TOKEN}`;
  try {
    await fs.writeFile(file, mine, { flag: 'wx', mode: 0o600 });
  } catch {
    const [pidText, token] = (await fs.readFile(file, 'utf8').catch(() => '')).trim().split(':');
    const pid = Number(pidText);
    const heldElsewhere = pid > 0 && pid !== process.pid && alive(pid);
    const heldByUs = pid === process.pid && token === OWN_TOKEN;
    if (heldElsewhere || heldByUs) return null;
    await fs.writeFile(file, mine, { mode: 0o600 });
  }
  return () => fs.rm(file, { force: true });
}

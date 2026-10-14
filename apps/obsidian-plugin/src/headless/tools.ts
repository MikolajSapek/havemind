/**
 * CLIs the agents service fetches for itself (plan 016). Claude Code is not
 * open source, so the public server image does not carry it: the first time
 * an agent thinks with Claude, the owner's own server installs the pinned
 * version into the agents volume, the same as `npx` would.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code@2.1.285';

export async function ensureClaudeCode(agentsDir: string): Promise<string> {
  const prefix = join(agentsDir, '.tools');
  const bin = join(prefix, 'node_modules', '.bin', 'claude');
  const installed = await fs.access(bin).then(() => true, () => false);
  if (installed) return bin;
  await fs.mkdir(prefix, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--omit=dev', CLAUDE_CODE_PACKAGE], {
      env: { PATH: process.env.PATH ?? '', HOME: prefix, npm_config_cache: join(prefix, '.npm-cache') },
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Installing Claude Code failed (${code}).`))));
  });
  return bin;
}

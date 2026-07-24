import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  generateCheckpointKeypair,
  loadSodium,
  type Sodium,
} from '@havemind/crypto';

import {
  parseCheckpointPublicKeyHex,
  resolveCheckpointDir,
  type ServerEnvironment,
} from './config.js';
import {
  CheckpointError,
  createCheckpoint,
  pruneCheckpoints,
  restoreCheckpoint,
} from './checkpoint.js';
import { DB_FILENAME, openDatabase } from './db.js';
import type { CliResult } from './setup/cli.js';

/**
 * Async operator CLI for encrypted checkpoints (plans/006), dispatched from
 * `havemind checkpoint <subcommand>`. It is kept separate from the synchronous
 * `runCli` because it needs libsodium (WASM, async) and filesystem I/O.
 *
 * Trust boundary reminder: the server only ever holds the recipient PUBLIC key
 * (for `create`); the SECRET key lives OFF-SERVER in the owner recovery kit and
 * is supplied only to `restore`. This CLI never persists or logs the secret key.
 */
export interface CheckpointCliDependencies {
  readonly env: ServerEnvironment;
  readonly loadSodium?: () => Promise<Sodium>;
  readonly now?: () => Date;
}

const USAGE = [
  'Usage: havemind checkpoint <subcommand>',
  '',
  'Subcommands:',
  '  generate-keypair                     Generate an X25519 checkpoint recipient',
  '                                       keypair. Store the PUBLIC key on the',
  '                                       server; keep the SECRET key off-server',
  '                                       in the owner recovery kit.',
  '  create [--keep <n>]                  Seal a new checkpoint from the live data',
  '                                       directory to the checkpoint output dir.',
  '  restore --from <checkpointDir>       Decrypt and verify a checkpoint into an',
  '    --to <targetDir>                   empty target dir, fail-closed on any',
  '    (--secret-key <hex>|               tamper. The secret key comes from the',
  '     --secret-key-file <path>)         owner recovery kit, never the server.',
  '    [--public-key <hex>]',
].join('\n');

interface ParsedFlags {
  readonly flags: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || !token.startsWith('--')) {
      continue;
    }
    const name = token.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) {
      booleans.add(name);
    } else {
      flags.set(name, next);
      index += 1;
    }
  }
  return { booleans, flags };
}

function fail(message: string): CliResult {
  return { exitCode: 1, stderr: `${message}\n`, stdout: '' };
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function readKeyHex(
  parsed: ParsedFlags,
  flagName: string,
): Promise<string | null> {
  const inline = parsed.flags.get(flagName);
  if (inline !== undefined) {
    return inline.trim().toLowerCase();
  }
  const filePath = parsed.flags.get(`${flagName}-file`);
  if (filePath !== undefined) {
    const raw = await readFile(filePath, 'utf8');
    return raw.trim().toLowerCase();
  }
  return null;
}

function isHex32(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

async function runGenerateKeypair(
  sodium: Sodium,
): Promise<CliResult> {
  const keypair = generateCheckpointKeypair(sodium);
  const stdout = [
    'Checkpoint recipient keypair generated.',
    '',
    'Public key (store on the server, e.g. /srv/secrets/havemind_checkpoint_pubkey,',
    'chmod 0600, and set HAVEMIND_CHECKPOINT_PUBLIC_KEY):',
    `  ${toHex(keypair.publicKey)}`,
    '',
    'Secret key (write to the OWNER recovery kit, OFF-SERVER — NEVER store it on',
    'sapserver, in havemind.db, in logs, or in this repo):',
    `  ${toHex(keypair.secretKey)}`,
    '',
  ].join('\n');
  return { exitCode: 0, stderr: '', stdout };
}

async function runCreate(
  dependencies: CheckpointCliDependencies,
  parsed: ParsedFlags,
  sodium: Sodium,
): Promise<CliResult> {
  const dataDir = dependencies.env.HAVEMIND_DATA_DIR;
  if (dataDir === undefined || dataDir.trim() === '') {
    return fail(
      'checkpoint create requires HAVEMIND_DATA_DIR to point at the server data directory.',
    );
  }
  const checkpointsDir = resolveCheckpointDir(dependencies.env);
  if (checkpointsDir === null) {
    return fail(
      'checkpoint create requires HAVEMIND_CHECKPOINT_DIR or HAVEMIND_DATA_DIR.',
    );
  }
  let publicKeyHex: string | null;
  try {
    publicKeyHex =
      (await readKeyHex(parsed, 'public-key')) ??
      parseCheckpointPublicKeyHex(
        dependencies.env.HAVEMIND_CHECKPOINT_PUBLIC_KEY,
      );
  } catch (error) {
    return fail(`checkpoint create failed: ${(error as Error).message}`);
  }
  if (publicKeyHex === null || !isHex32(publicKeyHex)) {
    return fail(
      'checkpoint create requires a 32-byte recipient public key via ' +
        'HAVEMIND_CHECKPOINT_PUBLIC_KEY or --public-key <hex>.',
    );
  }

  let keep: number | null = null;
  const keepFlag = parsed.flags.get('keep');
  if (keepFlag !== undefined) {
    const parsedKeep = Number(keepFlag);
    if (!Number.isInteger(parsedKeep) || parsedKeep < 1) {
      return fail('checkpoint create: --keep must be an integer >= 1.');
    }
    keep = parsedKeep;
  }

  const database = openDatabase(join(dataDir.trim(), DB_FILENAME));
  try {
    const result = await createCheckpoint({
      checkpointsDir,
      database,
      dataDir: dataDir.trim(),
      publicKey: fromHex(publicKeyHex),
      sodium,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    const lines = [
      'Checkpoint created.',
      `  Checkpoint id: ${result.checkpointId}`,
      `  Location:      ${result.checkpointDir}`,
      `  Blobs sealed:  ${result.manifest.blobs.length}`,
      `  Server epoch:  ${result.manifest.serverEpoch}`,
    ];
    if (keep !== null) {
      const pruned = await pruneCheckpoints({ checkpointsDir, keep });
      lines.push(
        `  Retention:     kept ${pruned.kept.length}, removed ${pruned.removed.length} (verify-before-forget).`,
      );
    }
    lines.push('');
    return { exitCode: 0, stderr: '', stdout: lines.join('\n') };
  } catch (error) {
    if (error instanceof CheckpointError) {
      return fail(`checkpoint create failed: ${error.message}`);
    }
    throw error;
  } finally {
    database.close();
  }
}

async function runRestore(
  dependencies: CheckpointCliDependencies,
  parsed: ParsedFlags,
  sodium: Sodium,
): Promise<CliResult> {
  const from = parsed.flags.get('from');
  const to = parsed.flags.get('to');
  if (from === undefined || to === undefined) {
    return fail('checkpoint restore requires --from <checkpointDir> and --to <targetDir>.');
  }

  let secretKeyHex: string | null;
  let publicKeyHex: string | null;
  try {
    secretKeyHex = await readKeyHex(parsed, 'secret-key');
    publicKeyHex =
      (await readKeyHex(parsed, 'public-key')) ??
      parseCheckpointPublicKeyHex(
        dependencies.env.HAVEMIND_CHECKPOINT_PUBLIC_KEY,
      );
  } catch (error) {
    return fail(`checkpoint restore failed: ${(error as Error).message}`);
  }
  if (secretKeyHex === null || !isHex32(secretKeyHex)) {
    return fail(
      'checkpoint restore requires the owner secret key via --secret-key <hex> or --secret-key-file <path>.',
    );
  }
  if (publicKeyHex === null || !isHex32(publicKeyHex)) {
    return fail(
      'checkpoint restore requires the recipient public key via --public-key <hex> or HAVEMIND_CHECKPOINT_PUBLIC_KEY.',
    );
  }

  try {
    const epoch = await restoreCheckpoint({
      checkpointDir: from,
      publicKey: fromHex(publicKeyHex),
      secretKey: fromHex(secretKeyHex),
      sodium,
      targetDir: to,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    const stdout = [
      'Checkpoint restored and verified.',
      `  Target:        ${to}`,
      `  Instance id:   ${epoch.instanceId}`,
      `  New epoch:     ${epoch.serverEpoch}`,
      `  Restore epoch: ${epoch.restoreEpoch}`,
      '',
    ].join('\n');
    return { exitCode: 0, stderr: '', stdout };
  } catch (error) {
    if (error instanceof CheckpointError) {
      // Secret-free: CheckpointError never embeds contents/keys (plans/006 T5).
      return fail(`checkpoint restore failed [${error.code}]: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Runs `havemind checkpoint <subcommand>`. `argv` is everything AFTER the
 * `checkpoint` token. Pure with respect to the process (returns streams + exit
 * code); the bin wrapper writes them.
 */
export async function runCheckpointCli(
  argv: readonly string[],
  dependencies: CheckpointCliDependencies,
): Promise<CliResult> {
  const [subcommand, ...rest] = argv;
  const parsed = parseFlags(rest);
  const load = dependencies.loadSodium ?? loadSodium;

  switch (subcommand) {
    case 'generate-keypair':
      return runGenerateKeypair(await load());
    case 'create':
      return runCreate(dependencies, parsed, await load());
    case 'restore':
      return runRestore(dependencies, parsed, await load());
    case undefined:
    case 'help':
    case '--help':
      return { exitCode: 0, stderr: '', stdout: `${USAGE}\n` };
    default:
      return {
        exitCode: 1,
        stderr: `Unknown checkpoint subcommand: ${subcommand}\n${USAGE}\n`,
        stdout: '',
      };
  }
}

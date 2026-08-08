import { join } from 'node:path';

import {
  DEFAULT_BACKUP_KEEP,
  type ServerEnvironment,
} from './config.js';
import {
  restoreInstance,
  RestoreError,
  verifyBackupStructure,
} from './backup-restore.js';
import { isValidBackupId, runScheduledBackup } from './backup-scheduler.js';
import { DB_FILENAME, openDatabase } from './db.js';
import type { CliResult } from './setup/cli.js';

/**
 * Async operator CLI for plain (unsealed) backup artifacts, dispatched from
 * `havemind backup [...]`. Kept separate from the synchronous `runCli` because
 * every path here is filesystem I/O.
 *
 * These artifacts are the input to the off-box pipeline in
 * `ops/sapserver/restic`: the server's scheduled timer writes them into a host
 * bind mount, a sudo-free user cron ships them to the owner's Mac inside a
 * restic-encrypted repository, and `restore-drill.sh` pulls one back and runs
 * `backup restore` against a scratch directory — the 1.0 release gate.
 *
 * Confidentiality note: an artifact is a byte-for-byte copy of data the live
 * volume already stores unencrypted, so it must be treated exactly like the data
 * directory. For an artifact that is encrypted AT REST on the host, use
 * `havemind checkpoint create` instead — that path seals every part to an
 * off-server public key, at the cost of needing the owner's secret key to
 * restore (and therefore to drill).
 */
export interface BackupCliDependencies {
  readonly env: ServerEnvironment;
  readonly now?: () => Date;
  readonly backupId?: () => string;
}

const USAGE = [
  'Usage: havemind backup [subcommand]',
  '',
  '  backup [--to <dir>] [--keep <n>]     Write one artifact into <dir> (default:',
  '    [--id <name>]                      HAVEMIND_BACKUP_DIR) and apply keep-N',
  '                                       retention (default 7). Needs',
  '                                       HAVEMIND_DATA_DIR. --id must be one',
  '                                       path segment of [A-Za-z0-9._-].',
  '  backup verify --from <artifactDir>   Verify an artifact without restoring it:',
  '                                       manifest, snapshot size, SQLite',
  '                                       integrity_check and every blob',
  '                                       byte-for-byte.',
  '  backup restore --from <artifactDir>  Restore into an EMPTY target directory,',
  '    --to <targetDir>                   run integrity_check, then rotate the',
  '                                       instance epoch so stale-cursor clients',
  '                                       must reconcile.',
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

/** `sizeBytes` is optional on read: artifacts predate the recorded size. */
function describeSizeBytes(sizeBytes: number | undefined): string {
  return sizeBytes === undefined ? 'unknown' : `${String(sizeBytes)} bytes`;
}

function describeError(error: unknown): string {
  if (error instanceof RestoreError) {
    // Secret-free by contract: RestoreError never embeds contents or keys.
    return `[${error.code}] ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function runCreate(
  dependencies: BackupCliDependencies,
  parsed: ParsedFlags,
): Promise<CliResult> {
  const dataDir = dependencies.env.HAVEMIND_DATA_DIR;
  if (dataDir === undefined || dataDir.trim() === '') {
    return fail(
      'backup requires HAVEMIND_DATA_DIR to point at the server data directory.',
    );
  }
  const destination =
    parsed.flags.get('to') ?? dependencies.env.HAVEMIND_BACKUP_DIR;
  if (destination === undefined || destination.trim() === '') {
    return fail(
      'backup requires a destination: pass --to <dir> or set HAVEMIND_BACKUP_DIR.',
    );
  }

  let keep = DEFAULT_BACKUP_KEEP;
  const keepFlag = parsed.flags.get('keep');
  if (keepFlag !== undefined) {
    const parsedKeep = Number(keepFlag);
    if (!Number.isInteger(parsedKeep) || parsedKeep < 1) {
      return fail('backup: --keep must be an integer >= 1.');
    }
    keep = parsedKeep;
  }
  const explicitId = parsed.flags.get('id');
  if (explicitId !== undefined && !isValidBackupId(explicitId)) {
    // An artifact id becomes a directory name under the backups root, so an id
    // holding a separator or a `..` component would write outside it.
    return fail(
      'backup: --id must be a single path segment of 1-128 characters from [A-Za-z0-9._-], starting with a letter or digit.',
    );
  }
  const backupId =
    explicitId === undefined
      ? dependencies.backupId
      : (): string => explicitId;

  const database = openDatabase(join(dataDir.trim(), DB_FILENAME));
  try {
    const result = await runScheduledBackup({
      backupsRoot: destination.trim(),
      database,
      dataDir: dataDir.trim(),
      keep,
      ...(backupId === undefined ? {} : { backupId }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    const stdout = [
      'Backup created.',
      `  Artifact id:   ${result.backupId}`,
      `  Location:      ${result.backupDir}`,
      `  Blobs:         ${String(result.manifest.blobs.length)}`,
      `  Database size: ${describeSizeBytes(result.manifest.database.sizeBytes)}`,
      `  Instance id:   ${result.manifest.instanceId}`,
      `  Retention:     kept ${String(result.keptCount)}, removed ${String(
        result.removedCount,
      )} (verify-before-forget).`,
      '',
    ].join('\n');
    return { exitCode: 0, stderr: '', stdout };
  } catch (error) {
    return fail(`backup failed: ${describeError(error)}`);
  } finally {
    database.close();
  }
}

async function runVerify(parsed: ParsedFlags): Promise<CliResult> {
  const from = parsed.flags.get('from');
  if (from === undefined) {
    return fail('backup verify requires --from <artifactDir>.');
  }
  try {
    const manifest = await verifyBackupStructure(from);
    const stdout = [
      'PASS: backup artifact verified.',
      `  Location:      ${from}`,
      `  Created at:    ${manifest.createdAt}`,
      `  Instance id:   ${manifest.instanceId}`,
      `  Database:      ${describeSizeBytes(
        manifest.database.sizeBytes,
      )}, integrity_check ok`,
      `  Blobs:         ${String(manifest.blobs.length)} (all byte-exact)`,
      '',
    ].join('\n');
    return { exitCode: 0, stderr: '', stdout };
  } catch (error) {
    return fail(`FAIL: backup verify failed: ${describeError(error)}`);
  }
}

async function runRestore(
  dependencies: BackupCliDependencies,
  parsed: ParsedFlags,
): Promise<CliResult> {
  const from = parsed.flags.get('from');
  const to = parsed.flags.get('to');
  if (from === undefined || to === undefined) {
    return fail(
      'backup restore requires --from <artifactDir> and --to <targetDir>.',
    );
  }
  try {
    const epoch = await restoreInstance({
      backupDir: from,
      targetDir: to,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    const stdout = [
      'PASS: backup restored, verified and started.',
      `  Target:        ${to}`,
      `  Instance id:   ${epoch.instanceId}`,
      `  New epoch:     ${epoch.serverEpoch}`,
      `  Restore epoch: ${String(epoch.restoreEpoch)}`,
      '',
    ].join('\n');
    return { exitCode: 0, stderr: '', stdout };
  } catch (error) {
    return fail(`FAIL: backup restore failed: ${describeError(error)}`);
  }
}

/**
 * Runs `havemind backup [...]`. `argv` is everything AFTER the `backup` token.
 * Pure with respect to the process (returns streams + exit code); the bin
 * wrapper writes them.
 */
export async function runBackupCli(
  argv: readonly string[],
  dependencies: BackupCliDependencies,
): Promise<CliResult> {
  const [head, ...rest] = argv;

  // `havemind backup --to <dir>` creates; a leading bare word is a subcommand.
  if (head === undefined || head.startsWith('--')) {
    return runCreate(dependencies, parseFlags(argv));
  }

  const parsed = parseFlags(rest);
  switch (head) {
    case 'create':
      return runCreate(dependencies, parsed);
    case 'verify':
      return runVerify(parsed);
    case 'restore':
      return runRestore(dependencies, parsed);
    case 'help':
      return { exitCode: 0, stderr: '', stdout: `${USAGE}\n` };
    default:
      return {
        exitCode: 1,
        stderr: `Unknown backup subcommand: ${head}\n${USAGE}\n`,
        stdout: '',
      };
  }
}

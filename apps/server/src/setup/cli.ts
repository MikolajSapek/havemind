import { join } from 'node:path';

import {
  OwnerSetupError,
  OwnerSetupService,
  createLocalOwnerSetupContext,
} from '../auth/setup.js';
import type { ServerEnvironment } from '../config.js';
import { openDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import {
  formatDoctorReport,
  runDoctor,
  type DoctorOutputMode,
} from './doctor.js';
import { generateDatabaseKey } from './secrets.js';

/**
 * The operator-facing setup/diagnostics CLI (`havemind <command>`).
 *
 * `runCli` is pure with respect to the process: it returns the intended
 * streams and exit code rather than writing or exiting itself, so it is fully
 * unit-testable. The thin executable in `bin/havemind.js` wires it to the real
 * process.
 */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SetupSession {
  readonly service: OwnerSetupService;
  readonly close: () => void;
}

export interface CliDependencies {
  readonly env: ServerEnvironment;
  readonly randomBytesSource?: (size: number) => Buffer;
  readonly openSetupSession?: (databaseFile: string) => SetupSession;
  readonly stat?: (
    path: string,
  ) => { size: number; mode: number; isDirectory: boolean } | null;
}

const DEFAULT_DATABASE_FILENAME = 'havemind.db';

const USAGE = [
  'Usage: havemind <command>',
  '',
  'Commands:',
  '  setup --owner <name> --vault <name>   Initialise the instance owner and',
  '                                        print a single-use pairing token.',
  '  rotate-pairing                        Invalidate the old owner pairing token',
  '                                        and print a fresh single-use one.',
  '  generate-db-key                       Print a fresh 256-bit database key.',
  '  doctor [--json]                       Run secret-free diagnostics.',
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

function defaultOpenSetupSession(databaseFile: string): SetupSession {
  const database = openDatabase(databaseFile);
  runMigrations(database);
  return {
    close: () => {
      database.close();
    },
    service: new OwnerSetupService(database),
  };
}

function runGenerateDbKey(dependencies: CliDependencies): CliResult {
  const secret =
    dependencies.randomBytesSource === undefined
      ? generateDatabaseKey()
      : generateDatabaseKey(dependencies.randomBytesSource);
  const stdout = [
    secret.value,
    '',
    `# ${secret.entropyBits}-bit key. Write it to /srv/secrets/havemind_db_key (chmod 0600).`,
    `# Fingerprint (safe to record): ${secret.fingerprint}`,
    '',
  ].join('\n');
  return { exitCode: 0, stderr: '', stdout };
}

function runDoctorCommand(
  dependencies: CliDependencies,
  parsed: ParsedFlags,
): CliResult {
  const mode: DoctorOutputMode = parsed.booleans.has('json') ? 'json' : 'text';
  const report = runDoctor({
    env: dependencies.env,
    ...(dependencies.stat === undefined ? {} : { stat: dependencies.stat }),
  });
  const stdout = `${formatDoctorReport(report, mode)}\n`;
  return { exitCode: report.status === 'fail' ? 1 : 0, stderr: '', stdout };
}

function resolveDatabaseFile(env: ServerEnvironment): string | null {
  const dataDir = env.HAVEMIND_DATA_DIR;
  if (dataDir === undefined || dataDir.trim() === '') {
    return null;
  }
  return join(dataDir, DEFAULT_DATABASE_FILENAME);
}

function runSetup(
  dependencies: CliDependencies,
  parsed: ParsedFlags,
): CliResult {
  const databaseFile = resolveDatabaseFile(dependencies.env);
  if (databaseFile === null) {
    return {
      exitCode: 1,
      stderr:
        'setup requires HAVEMIND_DATA_DIR to point at the server data directory.\n',
      stdout: '',
    };
  }
  const openSession =
    dependencies.openSetupSession ?? defaultOpenSetupSession;
  const session = openSession(databaseFile);
  try {
    const result = session.service.initializeOwner(
      createLocalOwnerSetupContext(),
      {
        ownerDisplayName: parsed.flags.get('owner') ?? '',
        vaultDisplayName: parsed.flags.get('vault') ?? '',
      },
    );
    const stdout = [
      'Instance owner initialised.',
      `Owner user id: ${result.ownerUserId}`,
      `Pairing token (single-use, expires ${result.pairingExpiresAt}):`,
      `  ${result.pairingToken}`,
      '',
      'Hand this token to the first device now; only its hash is stored server-side.',
      '',
    ].join('\n');
    return { exitCode: 0, stderr: '', stdout };
  } catch (error) {
    if (error instanceof OwnerSetupError) {
      return {
        exitCode: 1,
        stderr: `setup failed: ${error.message}\n`,
        stdout: '',
      };
    }
    throw error;
  } finally {
    session.close();
  }
}

function runRotatePairing(dependencies: CliDependencies): CliResult {
  const databaseFile = resolveDatabaseFile(dependencies.env);
  if (databaseFile === null) {
    return {
      exitCode: 1,
      stderr:
        'rotate-pairing requires HAVEMIND_DATA_DIR to point at the server data directory.\n',
      stdout: '',
    };
  }
  const openSession = dependencies.openSetupSession ?? defaultOpenSetupSession;
  const session = openSession(databaseFile);
  try {
    const result = session.service.rotateOwnerPairing(
      createLocalOwnerSetupContext(),
    );
    const stdout = [
      'Previous owner pairing token invalidated.',
      `Fresh pairing token (single-use, expires ${result.pairingExpiresAt}):`,
      `  ${result.pairingToken}`,
      '',
      'Hand this token to the owner device now; only its hash is stored server-side.',
      '',
    ].join('\n');
    return { exitCode: 0, stderr: '', stdout };
  } catch (error) {
    if (error instanceof OwnerSetupError) {
      return {
        exitCode: 1,
        stderr: `rotate-pairing failed: ${error.message}\n`,
        stdout: '',
      };
    }
    throw error;
  } finally {
    session.close();
  }
}

export function runCli(
  argv: readonly string[],
  dependencies: CliDependencies,
): CliResult {
  const [command, ...rest] = argv;
  const parsed = parseFlags(rest);
  switch (command) {
    case 'setup':
      return runSetup(dependencies, parsed);
    case 'rotate-pairing':
      return runRotatePairing(dependencies);
    case 'generate-db-key':
      return runGenerateDbKey(dependencies);
    case 'doctor':
      return runDoctorCommand(dependencies, parsed);
    case undefined:
    case 'help':
    case '--help':
      return { exitCode: 0, stderr: '', stdout: `${USAGE}\n` };
    default:
      return {
        exitCode: 1,
        stderr: `Unknown command: ${command}\n${USAGE}\n`,
        stdout: '',
      };
  }
}

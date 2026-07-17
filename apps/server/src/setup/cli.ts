import { join } from 'node:path';

import type Database from 'better-sqlite3';

import {
  InvitationError,
  InvitationService,
  type InvitationRole,
} from '../auth/invitations.js';
import {
  OwnerSetupError,
  OwnerSetupService,
  createLocalOwnerSetupContext,
} from '../auth/setup.js';
import { parseVerificationPin } from '../auth/verification-pin.js';
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

export interface InvitationSession {
  readonly service: InvitationService;
  readonly database: Database.Database;
  readonly close: () => void;
}

export interface CliDependencies {
  readonly env: ServerEnvironment;
  readonly randomBytesSource?: (size: number) => Buffer;
  readonly openSetupSession?: (databaseFile: string) => SetupSession;
  readonly openInvitationSession?: (databaseFile: string) => InvitationSession;
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
  '  create-invitation [--role <role>]     Mint an invitation and print the secure',
  '    [--name <name>]                     v1. envelope for the joining device.',
  '  approve [--invitation <id>]           List devices awaiting approval, or',
  '    [--phrase <phrase>]                 approve one after comparing the phrase.',
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

function defaultOpenInvitationSession(databaseFile: string): InvitationSession {
  const database = openDatabase(databaseFile);
  runMigrations(database);
  return {
    close: () => {
      database.close();
    },
    database,
    service: new InvitationService(database),
  };
}

interface OwnerContextRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly vaultId: string;
}

/** Resolves the single instance owner's active owner membership. */
function resolveOwnerContext(
  database: Database.Database,
): OwnerContextRow | null {
  const row = database
    .prepare(
      `SELECT m.id AS membershipId, m.user_id AS userId, m.vault_id AS vaultId
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.role = 'owner' AND m.status = 'active'
         AND u.is_instance_owner = 1 AND u.status = 'active'
       ORDER BY m.created_at, m.id
       LIMIT 1`,
    )
    .get() as OwnerContextRow | undefined;
  return row ?? null;
}

/** Resolves an approved device for the owner to act as the inviter device. */
function resolveOwnerDeviceId(
  database: Database.Database,
  userId: string,
): string | null {
  const row = database
    .prepare(
      `SELECT id AS deviceId FROM devices
       WHERE user_id = ? AND status = 'approved'
       ORDER BY created_at, id
       LIMIT 1`,
    )
    .get(userId) as { deviceId: string } | undefined;
  return row?.deviceId ?? null;
}

/** The canonical https origin the joining device must dial back, or null. */
function resolveServerOrigin(env: ServerEnvironment): string | null {
  const value = env.HAVEMIND_API_BASE_URL;
  if (value === undefined || value.trim() === '') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? url.origin : null;
}

/**
 * Serialises the invitation into the canonical `v1.<base64url>` envelope the
 * plugin's paste-to-connect flow expects: base64url of the exact key order
 * `{version, serverOrigin, invitationToken}`, no padding.
 */
function buildInviteEnvelope(
  serverOrigin: string,
  invitationToken: string,
): string {
  const json = JSON.stringify({
    version: 1,
    serverOrigin,
    invitationToken,
  });
  return `v1.${Buffer.from(json, 'utf8').toString('base64url')}`;
}

interface PendingApproval {
  readonly deviceDisplayName: string;
  readonly intendedMemberDisplayName: string;
  readonly invitationId: string;
  readonly verificationPhrase: string;
}

interface PendingDeviceRow {
  readonly invitationId: string;
  readonly vaultId: string;
  readonly inviterDeviceId: string;
  readonly verificationSecret: string;
  readonly pendingDeviceId: string;
  readonly deviceDisplayName: string;
  readonly intendedMemberDisplayName: string | null;
}

/** Every redeemed-but-unapproved device with the phrase the owner compares. */
function listPendingApprovals(
  database: Database.Database,
): readonly PendingApproval[] {
  const rows = database
    .prepare(
      `SELECT i.id AS invitationId,
              i.vault_id AS vaultId,
              i.inviter_device_id AS inviterDeviceId,
              i.verification_secret AS verificationSecret,
              i.pending_device_id AS pendingDeviceId,
              i.intended_member_display_name AS intendedMemberDisplayName,
              d.display_name AS deviceDisplayName
       FROM invitations i
       JOIN devices d ON d.id = i.pending_device_id
       WHERE d.status = 'pending'
       ORDER BY i.created_at, i.id`,
    )
    .all() as PendingDeviceRow[];
  return rows.map((row) => ({
    deviceDisplayName: row.deviceDisplayName,
    intendedMemberDisplayName:
      row.intendedMemberDisplayName ?? '(unspecified)',
    invitationId: row.invitationId,
    // The stored secret is the 6-digit PIN itself; the operator reads it out to
    // confirm what the joining device displays.
    verificationPhrase: parseVerificationPin(row.verificationSecret),
  }));
}

function runCreateInvitation(
  dependencies: CliDependencies,
  parsed: ParsedFlags,
): CliResult {
  const databaseFile = resolveDatabaseFile(dependencies.env);
  if (databaseFile === null) {
    return {
      exitCode: 1,
      stderr:
        'create-invitation requires HAVEMIND_DATA_DIR to point at the server data directory.\n',
      stdout: '',
    };
  }
  const serverOrigin = resolveServerOrigin(dependencies.env);
  if (serverOrigin === null) {
    return {
      exitCode: 1,
      stderr:
        'create-invitation requires HAVEMIND_API_BASE_URL to be a canonical https origin.\n',
      stdout: '',
    };
  }
  const openSession =
    dependencies.openInvitationSession ?? defaultOpenInvitationSession;
  const session = openSession(databaseFile);
  try {
    const owner = resolveOwnerContext(session.database);
    if (owner === null) {
      return {
        exitCode: 1,
        stderr:
          'create-invitation failed: the instance owner has not been initialised yet.\n',
        stdout: '',
      };
    }
    const inviterDeviceId = resolveOwnerDeviceId(
      session.database,
      owner.userId,
    );
    if (inviterDeviceId === null) {
      return {
        exitCode: 1,
        stderr:
          'create-invitation failed: no approved owner device found; pair the owner device first.\n',
        stdout: '',
      };
    }
    const role = parsed.flags.get('role');
    const name = parsed.flags.get('name');
    const created = session.service.createInvitation({
      createdByMembershipId: owner.membershipId,
      inviterDeviceId,
      vaultId: owner.vaultId,
      ...(role === undefined ? {} : { intendedRole: role as InvitationRole }),
      ...(name === undefined ? {} : { intendedMemberDisplayName: name }),
    });
    const envelope = buildInviteEnvelope(serverOrigin, created.invitationToken);
    const stdout = [
      'Invitation created.',
      `Intended member: ${created.intendedMemberDisplayName}`,
      `Expires (single-use): ${created.expiresAt}`,
      '',
      'Secure invitation envelope (hand to the joining device now):',
      `  ${envelope}`,
      '',
      'The joining device redeems it, then run `havemind approve` to finish.',
      '',
    ].join('\n');
    return { exitCode: 0, stderr: '', stdout };
  } catch (error) {
    if (error instanceof InvitationError) {
      return {
        exitCode: 1,
        stderr: `create-invitation failed: ${error.message}\n`,
        stdout: '',
      };
    }
    throw error;
  } finally {
    session.close();
  }
}

function runApprove(
  dependencies: CliDependencies,
  parsed: ParsedFlags,
): CliResult {
  const databaseFile = resolveDatabaseFile(dependencies.env);
  if (databaseFile === null) {
    return {
      exitCode: 1,
      stderr:
        'approve requires HAVEMIND_DATA_DIR to point at the server data directory.\n',
      stdout: '',
    };
  }
  const openSession =
    dependencies.openInvitationSession ?? defaultOpenInvitationSession;
  const session = openSession(databaseFile);
  try {
    const owner = resolveOwnerContext(session.database);
    if (owner === null) {
      return {
        exitCode: 1,
        stderr:
          'approve failed: the instance owner has not been initialised yet.\n',
        stdout: '',
      };
    }
    const pending = listPendingApprovals(session.database);
    const invitationId = parsed.flags.get('invitation');
    if (invitationId === undefined) {
      if (pending.length === 0) {
        return {
          exitCode: 0,
          stderr: '',
          stdout: 'No devices awaiting approval.\n',
        };
      }
      const lines = ['Devices awaiting approval:', ''];
      for (const item of pending) {
        lines.push(`Invitation: ${item.invitationId}`);
        lines.push(`  Device:              ${item.deviceDisplayName}`);
        lines.push(`  Intended member:     ${item.intendedMemberDisplayName}`);
        lines.push(`  Verification code:   ${item.verificationPhrase}`);
        lines.push('');
      }
      lines.push('Compare the 6-digit code with the joining device, then run:');
      lines.push('  havemind approve --invitation <invitationId>');
      lines.push('');
      return { exitCode: 0, stderr: '', stdout: lines.join('\n') };
    }

    const match = pending.find((item) => item.invitationId === invitationId);
    if (match === undefined) {
      return {
        exitCode: 1,
        stderr: 'approve failed: no pending device matches that invitation id.\n',
        stdout: '',
      };
    }
    // Default to the server-derived phrase the operator already compared in the
    // listing; an explicit --phrase re-checks a phrase typed from the invitee.
    const verificationPhrase =
      parsed.flags.get('phrase') ?? match.verificationPhrase;
    const result = session.service.approveRedeemedDevice({
      approverMembershipId: owner.membershipId,
      invitationId,
      verificationPhrase,
    });
    const stdout = [
      'Pending device approved.',
      `Device id:     ${result.deviceId}`,
      `Membership id: ${result.membershipId}`,
      '',
    ].join('\n');
    return { exitCode: 0, stderr: '', stdout };
  } catch (error) {
    if (error instanceof InvitationError) {
      return {
        exitCode: 1,
        stderr: `approve failed: ${error.message}\n`,
        stdout: '',
      };
    }
    throw error;
  } finally {
    session.close();
  }
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
    case 'create-invitation':
      return runCreateInvitation(dependencies, parsed);
    case 'approve':
      return runApprove(dependencies, parsed);
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

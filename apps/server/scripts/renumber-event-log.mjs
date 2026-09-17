#!/usr/bin/env node
/**
 * Rebuild a vault's event log as a dense, gap-free sequence.
 *
 * WHY THIS EXISTS
 *
 * `compactSupersededRevisions` used to delete superseded revisions. Because
 * `vault_events.revision_id` is `ON DELETE CASCADE`, each delete also removed
 * that revision's event row, while `vaults.next_server_sequence` kept counting.
 * A vault that had been compacted therefore advertises a cursor for sequences it
 * can no longer serve, and its log looks like `3, 5, 6, 7, 9, ...`.
 *
 * Both client paths refuse to cross such a hole, by design (rule 3, never skip a
 * revision): the ordinary pull stops at the first gap and never advances, and a
 * cursor-zero bootstrap returns empty and stays at zero. So every device silently
 * stops receiving anything. The deleted rows cannot be recovered, they are gone,
 * but the CURRENT content is intact: every file head still has its revision.
 *
 * WHAT THIS DOES
 *
 * Renumbers the surviving events of a vault to 1..N in their existing order,
 * keeping every revision, head, blob and file exactly as it is, and resets the
 * vault's `next_server_sequence` to N+1. Nothing is deleted. Afterwards the log
 * is contiguous, so clients resume normally. Devices must re-pull from zero,
 * so their stored cursors are cleared too (a cursor into the old numbering is
 * meaningless once the sequence changes).
 *
 * The compaction bug itself is fixed separately (superseded revisions are no
 * longer deleted); this script only repairs vaults damaged before that fix.
 *
 * USAGE
 *   node renumber-event-log.mjs <database-path> [--vault <id>] [--apply]
 *
 * Without `--apply` it only reports what it would do. Always take a backup
 * first: this rewrites primary keys in place.
 */

import Database from 'better-sqlite3';

function parseArgs(argv) {
  const [databasePath, ...rest] = argv;
  if (databasePath === undefined) {
    throw new Error(
      'Usage: node renumber-event-log.mjs <database-path> [--vault <id>] [--apply]',
    );
  }
  let vaultId = null;
  let apply = false;
  let resyncRevisions = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--apply') apply = true;
    else if (flag === '--resync-revisions') resyncRevisions = true;
    else if (flag === '--vault') {
      vaultId = rest[index + 1] ?? null;
      index += 1;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return { databasePath, vaultId, apply, resyncRevisions };
}

/** Vaults with at least one missing sequence between 1 and their max event. */
function surveyVaults(database, onlyVaultId) {
  const rows = database
    .prepare(
      `SELECT v.id AS vaultId,
              v.next_server_sequence AS nextSequence,
              COUNT(e.server_sequence) AS eventCount,
              COALESCE(MAX(e.server_sequence), 0) AS maxSequence,
              COALESCE(MIN(e.server_sequence), 0) AS minSequence
         FROM vaults v
         LEFT JOIN vault_events e ON e.vault_id = v.id
        GROUP BY v.id`,
    )
    .all();
  return rows
    .filter((row) => onlyVaultId === null || row.vaultId === onlyVaultId)
    .map((row) => ({
      ...row,
      // A dense log runs 1..eventCount, so anything else means holes.
      holes: Math.max(0, row.maxSequence - row.eventCount),
      dense: row.minSequence === 1 && row.maxSequence === row.eventCount,
    }));
}

/**
 * Renumbers one vault's events to 1..N in their current order.
 *
 * Two passes, because `(vault_id, server_sequence)` is the primary key and a
 * straight update would collide with a row that still holds the target number:
 * first shift every row far above the current maximum, then bring them down
 * into their final positions.
 */
function renumberVault(database, vaultId) {
  const events = database
    .prepare(
      `SELECT server_sequence AS sequence
         FROM vault_events
        WHERE vault_id = ?
        ORDER BY server_sequence`,
    )
    .all(vaultId);
  if (events.length === 0) return { renumbered: 0, nextSequence: 1 };

  // Above the highest sequence in EITHER table, so the parking range cannot
  // collide with a revision that outlives its event (or vice versa).
  const offset =
    Math.max(
      database
        .prepare(
          `SELECT COALESCE(MAX(server_sequence), 0) AS max FROM vault_events WHERE vault_id = ?`,
        )
        .get(vaultId).max,
      database
        .prepare(
          `SELECT COALESCE(MAX(server_sequence), 0) AS max FROM revisions WHERE vault_id = ?`,
        )
        .get(vaultId).max,
    ) + 1_000_000;

  // `revisions.server_sequence` and `vault_events.server_sequence` are the SAME
  // number for the same commit, and `listHeadEvents` joins the two tables on it.
  // Renumbering only one side silently breaks that join: a file head whose
  // revision still carries the old sequence resolves to no event, the snapshot
  // pull returns a short page, and the vault looks half-empty to every client.
  // So both tables move together, inside one transaction.
  const shiftEvent = database.prepare(
    `UPDATE vault_events SET server_sequence = ? WHERE vault_id = ? AND server_sequence = ?`,
  );
  const shiftRevision = database.prepare(
    `UPDATE revisions SET server_sequence = ? WHERE vault_id = ? AND server_sequence = ?`,
  );
  const shift = (next, vault, current) => {
    shiftEvent.run(next, vault, current);
    shiftRevision.run(next, vault, current);
  };

  const run = database.transaction(() => {
    // Pass 1: move every row out of the way, preserving order. Two passes are
    // needed because (vault_id, server_sequence) is unique in both tables, so a
    // direct update would collide with a row still holding the target number.
    events.forEach((event, index) => {
      shift(offset + index, vaultId, event.sequence);
    });
    // Pass 2: settle them at 1..N.
    events.forEach((_event, index) => {
      shift(index + 1, vaultId, offset + index);
    });
    database
      .prepare(`UPDATE vaults SET next_server_sequence = ? WHERE id = ?`)
      .run(events.length + 1, vaultId);
    // Every stored cursor refers to the OLD numbering, so it would now point at
    // the wrong revision. Clear them: each device re-pulls from zero and
    // materialises the current heads, which is exactly a normal join.
    database
      .prepare(
        `UPDATE devices SET last_ack_sequence = NULL, last_ack_at = NULL
          WHERE vault_id = ?
             OR (vault_id IS NULL
                 AND user_id IN (SELECT user_id FROM memberships WHERE vault_id = ?))`,
      )
      .run(vaultId, vaultId);
  });
  run();
  return { renumbered: events.length, nextSequence: events.length + 1 };
}

/**
 * Puts each revision back on the sequence its OWN event carries.
 *
 * Repairs a database left half-renumbered by an earlier version of this script,
 * which moved `vault_events.server_sequence` without moving
 * `revisions.server_sequence`. The head lookup joins those two columns, so most
 * files resolved to no event and the server answered 409/500 on every pull.
 *
 * `vault_events.revision_id` is untouched by that damage, so it is the
 * authority: for every event, its named revision belongs at its sequence.
 * Two passes for the same uniqueness reason as `renumberVault`.
 */
function resyncRevisionsToEvents(database, vaultId) {
  const pairs = database
    .prepare(
      `SELECT e.server_sequence AS target, r.id AS revisionId,
              r.server_sequence AS current
         FROM vault_events e
         JOIN revisions r ON r.id = e.revision_id
        WHERE e.vault_id = ? AND r.server_sequence <> e.server_sequence
        ORDER BY e.server_sequence`,
    )
    .all(vaultId);
  if (pairs.length === 0) return 0;

  const offset =
    Math.max(
      database
        .prepare(
          `SELECT COALESCE(MAX(server_sequence), 0) AS max FROM revisions WHERE vault_id = ?`,
        )
        .get(vaultId).max,
      database
        .prepare(
          `SELECT COALESCE(MAX(server_sequence), 0) AS max FROM vault_events WHERE vault_id = ?`,
        )
        .get(vaultId).max,
    ) + 1_000_000;

  const setById = database.prepare(
    `UPDATE revisions SET server_sequence = ? WHERE id = ?`,
  );
  const run = database.transaction(() => {
    pairs.forEach((pair, index) => setById.run(offset + index, pair.revisionId));
    pairs.forEach((pair) => setById.run(pair.target, pair.revisionId));
  });
  run();
  return pairs.length;
}

function main() {
  const { databasePath, vaultId, apply, resyncRevisions } = parseArgs(
    process.argv.slice(2),
  );
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');

  const vaults = surveyVaults(database, vaultId);
  if (vaults.length === 0) {
    console.error('No matching vault found.');
    process.exitCode = 1;
    return;
  }

  for (const vault of vaults) {
    const state = vault.dense ? 'dense' : `HOLES: ${vault.holes}`;
    console.log(
      `${vault.vaultId}  events=${vault.eventCount}  range=${vault.minSequence}..${vault.maxSequence}  next=${vault.nextSequence}  ${state}`,
    );
  }

  // Revision/event desync is reported (and repaired) independently of holes: a
  // half-renumbered database has a perfectly contiguous log and is still broken.
  const desynced = database
    .prepare(
      `SELECT COUNT(*) AS count
         FROM vault_events e
         JOIN revisions r ON r.id = e.revision_id
        WHERE r.server_sequence <> e.server_sequence
          ${vaultId === null ? '' : 'AND e.vault_id = ?'}`,
    )
    .get(...(vaultId === null ? [] : [vaultId])).count;
  if (desynced > 0) {
    console.log(
      `\n${desynced} revision(s) sit on a different sequence than their event.`,
    );
    if (resyncRevisions && apply) {
      const targets =
        vaultId === null
          ? vaults.map((vault) => vault.vaultId)
          : [vaultId];
      let fixed = 0;
      for (const target of targets) fixed += resyncRevisionsToEvents(database, target);
      console.log(`resynced ${fixed} revision(s) to their event sequence.`);
    } else if (!resyncRevisions) {
      console.log('Re-run with --resync-revisions --apply to repair that.');
    }
  }

  const damaged = vaults.filter((vault) => !vault.dense && vault.eventCount > 0);
  if (damaged.length === 0) {
    if (desynced === 0) {
      console.log('\nNothing to repair: every log is already contiguous.');
      return;
    }
    if (!(resyncRevisions && apply)) return;
    verifyInvariants(database, vaultId);
    return;
  }

  if (!apply) {
    console.log(
      `\nDry run. ${damaged.length} vault(s) would be renumbered to 1..N and every device cursor cleared.`,
    );
    console.log('Re-run with --apply (after a backup) to perform the repair.');
    return;
  }

  for (const vault of damaged) {
    const result = renumberVault(database, vault.vaultId);
    console.log(
      `repaired ${vault.vaultId}: ${result.renumbered} events renumbered, next_server_sequence=${result.nextSequence}`,
    );
  }

  verifyInvariants(database, vaultId);
}

/** Fails loudly unless every log is contiguous and every revision has its event. */
function verifyInvariants(database, vaultId) {
  for (const vault of surveyVaults(database, vaultId)) {
    if (vault.eventCount > 0 && !vault.dense) {
      throw new Error(`Vault ${vault.vaultId} is still not contiguous.`);
    }
  }
  // Every revision must still pair with its own event on server_sequence: that
  // join is how a file head resolves to the event a client receives, and a
  // half-renumbered database silently serves a fraction of the vault.
  const orphans = database
    .prepare(
      `SELECT COUNT(*) AS count
         FROM revisions r
         LEFT JOIN vault_events e
           ON e.vault_id = r.vault_id AND e.server_sequence = r.server_sequence
        WHERE e.server_sequence IS NULL`,
    )
    .get().count;
  if (orphans > 0) {
    throw new Error(
      `${orphans} revision(s) have no matching event; the database is half-renumbered.`,
    );
  }
  console.log(
    '\nVerified: every repaired log is contiguous and every revision still pairs with its event.',
  );
}

main();
